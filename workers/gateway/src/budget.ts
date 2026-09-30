// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * budget.ts — the daily D1 write budget.
 *
 * Cloudflare D1 bills rows written, so a Worker deployment on a busy APRS-IS feed can run up a bill (or
 * exhaust the free plan's daily allowance) without anyone noticing. The guard counts the rows the gateway
 * writes each UTC day against D1_DAILY_WRITE_BUDGET and, as the count nears the budget, sheds the writes
 * that matter least (ingest.ts decides which):
 *
 *   ok    below 80 %  — everything is stored as configured
 *   warn  from 80 %   — the raw packet ring pauses; a stationary station nothing protects stores a fix six
 *                       times less often (POS_MIN_INTERVAL_S × 6)
 *   over  from 100 %  — only protected stations' fixes, RF hearings, finds, account and federation data are
 *                       stored; the rest reaches the live map without being persisted
 *
 * Protected data is never throttled, and neither is the nightly prune (it only ever shrinks the tables).
 * The sysop hears about each threshold once per UTC day: a banner on the instance admin surface and a line
 * in the email digest.
 *
 * Counting. {@link meterWrites} wraps the D1 binding once per env and adds each result's
 * `meta.rows_written` to a pending count; the ingest hands the pending count to the counter with its live
 * dispatch, and the scheduled jobs hand theirs over when they finish. `first()` returns no meta, so a write
 * made through it is not counted (the ingest and the scheduled jobs write through `run()`/`all()`/`batch()`).
 *
 * The counter lives in the live room (room.ts on Cloudflare, rooms-core.ts on Node and Bun): one place all
 * isolates share, whose storage is billed apart from D1. It keeps the day's total in memory and writes it
 * to storage at most once a minute (plus once for each alert raised or mailed), so its own cost is at most
 * about 1,440 storage writes a day. When the object leaves memory it resumes from the last stored total: the
 * count can miss up to a minute of writes, which is noise against a daily budget.
 *
 * Runtimes. The Worker applies the default budget ({@link applyWorkerDefaults}, called from index.ts only);
 * the Node and Bun servers never call it, so there the guard is off unless the setting is present — a
 * self-host SQLite file costs the same whatever it writes.
 */
import type { Env } from "./env.js";
import type { SqlDatabase, SqlResult, SqlStatement } from "./runtime.js";
import { json } from "./app.js";
import { adminCalls } from "./admin.js";
import { isCallsignVerified } from "./callsign.js";
import { sendEmail } from "./email.js";
import { baseCall } from "@aprscaching/aprs";
import { LIVE_REGION } from "./live.js";

/** The Worker's budget when D1_DAILY_WRITE_BUDGET is unset: 50 M rows/month included on Workers Paid, per day. */
const WORKER_DAILY_WRITE_BUDGET = "1500000";

/** The counter writes its storage at most this often. */
const SAVE_EVERY_MS = 60_000;

/** How long a level the ingest learned stays good before it asks the room again. */
const LEVEL_TTL_MS = 60_000;

type BudgetLevel = "off" | "ok" | "warn" | "over";

/** One threshold crossed on one UTC day. */
interface BudgetAlert {
  day: string;
  threshold: 80 | 100;
  /** unix ms the threshold was crossed */
  at: number;
  /** rows written that day when it was crossed */
  used: number;
  /** already in an email digest */
  mailed: boolean;
}

/** What the counter stores. */
export interface BudgetState {
  day: string;
  used: number;
  alerts: BudgetAlert[];
}

/** The counter as the gateway and the admin surface see it. */
interface BudgetView {
  day: string;
  used: number;
  budget: number;
  level: BudgetLevel;
  /** today's alerts, and earlier ones not yet mailed */
  alerts: BudgetAlert[];
}

/** Where the counter keeps its state between restarts. */
export interface BudgetStore {
  load(): Promise<BudgetState | undefined>;
  save(state: BudgetState): Promise<void>;
}

const blank = (v: string | undefined): boolean => typeof v !== "string" || v.trim() === "";

const parseBudget = (raw: string | undefined): number | null => {
  if (blank(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** The Worker's defaults: the budget is on unless D1_DAILY_WRITE_BUDGET says otherwise. Fills `env` in place. */
export function applyWorkerDefaults(env: Env): Env {
  if (parseBudget(env.D1_DAILY_WRITE_BUDGET) === null) env.D1_DAILY_WRITE_BUDGET = WORKER_DAILY_WRITE_BUDGET;
  return env;
}

/** Rows a day the instance may write before it sheds writes; 0 ⇒ the guard is off. */
export function writeBudget(env: Env): number {
  return parseBudget(env.D1_DAILY_WRITE_BUDGET) ?? 0;
}

/**
 * Rows one D1 result wrote. D1 reports `rows_written` (index rows included; a read reports 0). The Node and
 * Bun SQLite shim reports only `changes`, the rows a statement changed, so there the count leaves out index
 * rows and runs low.
 */
export function rowsWritten(meta: { rows_written?: number; changes?: number } | undefined): number {
  const n = meta?.rows_written ?? meta?.changes ?? 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayBefore = (day: string): string => utcDay(Date.parse(`${day}T00:00:00Z`) - 86_400_000);
const alertKey = (a: { day: string; threshold: number }) => `${a.day}/${a.threshold}`;

function levelOf(used: number, budget: number): BudgetLevel {
  if (budget <= 0) return "off";
  if (used >= budget) return "over";
  return used * 100 >= budget * 80 ? "warn" : "ok";
}

/**
 * The day's running total. It lives in the memory of the room that holds it, and `store` keeps it across
 * restarts at most once every {@link SAVE_EVERY_MS} — or at once when an alert is raised or mailed, which
 * happens a few times a day at most.
 */
export class BudgetCounter {
  private state?: BudgetState;
  private loading?: Promise<void>;
  private savedAt = -Infinity;

  constructor(
    private store: BudgetStore,
    private now: () => number = Date.now,
  ) {}

  /** Today's state, loaded once and rolled over at 00:00 UTC. */
  private async current(): Promise<BudgetState> {
    // one load for every request that races the first one, so no count is overwritten by a second load
    this.loading ??= this.store.load().then((s) => {
      this.state ??= s ?? { day: utcDay(this.now()), used: 0, alerts: [] };
    });
    await this.loading;
    const s = this.state!;
    const day = utcDay(this.now());
    if (s.day !== day) {
      s.day = day;
      s.used = 0;
    }
    // alerts are listed through the day after theirs, when the nightly digest mails them
    const since = dayBefore(day);
    s.alerts = s.alerts.filter((a) => a.day >= since);
    return s;
  }

  private async save(force: boolean): Promise<void> {
    const t = this.now();
    if (!force && t - this.savedAt < SAVE_EVERY_MS) return;
    this.savedAt = t;
    await this.store.save(structuredClone(this.state!));
  }

  private viewOf(s: BudgetState, budget: number): BudgetView {
    return {
      day: s.day,
      used: s.used,
      budget,
      level: levelOf(s.used, budget),
      alerts: s.alerts.filter((a) => a.day === s.day || !a.mailed).map((a) => ({ ...a })),
    };
  }

  /** Count `rows` more rows written today; raise each threshold's alert the first time the day crosses it. */
  async add(rows: number, budget: number): Promise<BudgetView> {
    const s = await this.current();
    s.used += rows;
    let raised = false;
    if (budget > 0)
      for (const threshold of [80, 100] as const) {
        const crossed = s.used * 100 >= budget * threshold;
        if (crossed && !s.alerts.some((a) => a.day === s.day && a.threshold === threshold)) {
          s.alerts.push({ day: s.day, threshold, at: this.now(), used: s.used, mailed: false });
          raised = true;
        }
      }
    await this.save(raised);
    return this.viewOf(s, budget);
  }

  async view(budget: number): Promise<BudgetView> {
    return this.viewOf(await this.current(), budget);
  }

  /** Mark alerts (`day/threshold`) as sent in a digest. */
  async markMailed(keys: string[]): Promise<void> {
    const s = await this.current();
    let changed = false;
    for (const a of s.alerts)
      if (!a.mailed && keys.includes(alertKey(a))) {
        a.mailed = true;
        changed = true;
      }
    if (changed) await this.save(true);
  }
}

/** A counter store that keeps nothing across a restart: the self-host runtimes, where the guard is opt-in. */
export const memoryBudgetStore = (): BudgetStore => ({
  load: () => Promise.resolve(undefined),
  save: () => Promise.resolve(),
});

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The live room's internal endpoints, the same on every runtime. Only the gateway itself reaches them, over
 * the room binding: the public /ws route forwards the client's own request, whose path is /ws, so a client
 * can neither broadcast nor count.
 *
 *   POST /dispatch {envelopes, budget?: {add, limit}}  fan the envelopes out; with `budget`, count `add` and
 *                                                     answer the counter's view (200), else 204
 *   GET  /budget?limit=N                              the counter's view
 *   POST /budget {add?, limit, mailed?}               count `add`, mark `mailed` alerts; answer the view
 *
 * Anything else is 426: the room otherwise only takes a WebSocket upgrade.
 */
export async function serveRoom(
  req: Request,
  fanOut: (envelopes: unknown[]) => void,
  counter: () => BudgetCounter,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/dispatch" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      envelopes?: unknown[];
      budget?: { add?: unknown; limit?: unknown };
    } | null;
    if (!body || !Array.isArray(body.envelopes)) return json({ error: "bad dispatch" }, { status: 400 });
    fanOut(body.envelopes);
    if (!body.budget) return new Response(null, { status: 204 });
    const add = count(body.budget.add),
      limit = count(body.budget.limit);
    if (add === null || limit === null) return json({ error: "bad budget" }, { status: 400 });
    return json(await counter().add(add, limit));
  }
  if (path === "/budget" && req.method === "GET") {
    const limit = count(Number(new URL(req.url).searchParams.get("limit") ?? 0)) ?? 0;
    return json(await counter().view(limit));
  }
  if (path === "/budget" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { add?: unknown; limit?: unknown; mailed?: unknown } | null;
    const add = count(body?.add ?? 0),
      limit = count(body?.limit);
    if (!body || add === null || limit === null) return json({ error: "bad budget" }, { status: 400 });
    if (Array.isArray(body.mailed)) await counter().markMailed(body.mailed.map(String));
    return json(await counter().add(add, limit));
  }
  return new Response("expected websocket", { status: 426 });
}

// ---- the gateway side: metering, the level the ingest acts on, and the flush to the room ----

interface Meter {
  /** rows written and not yet handed to the counter */
  pending: number;
  /** the last view the room answered, and when (unix ms) */
  view?: BudgetView;
  at: number;
}

/** Per room binding: the binding is the one object an instance's requests (and a Worker isolate's) share. */
const meters = new WeakMap<object, Meter>();
const METERED = Symbol("metered");

function meterOf(env: Env): Meter {
  const key = env.ROOMS as object;
  let m = meters.get(key);
  if (!m) meters.set(key, (m = { pending: 0, at: 0 }));
  return m;
}

/** A D1 binding that adds every result's rows written to `m.pending`. */
function metered(db: SqlDatabase, m: Meter): SqlDatabase {
  const note = <T>(r: SqlResult<T>): SqlResult<T> => {
    m.pending += rowsWritten(r?.meta);
    return r;
  };
  class Stmt implements SqlStatement {
    constructor(readonly inner: SqlStatement) {}
    bind(...values: unknown[]): SqlStatement {
      return new Stmt(this.inner.bind(...values));
    }
    async run<T = unknown>(): Promise<SqlResult<T>> {
      return note(await this.inner.run<T>());
    }
    async all<T = unknown>(): Promise<SqlResult<T>> {
      return note(await this.inner.all<T>());
    }
    first<T = unknown>(): Promise<T | null> {
      return this.inner.first<T>();
    }
  }
  return {
    [METERED]: true,
    prepare: (sql: string) => new Stmt(db.prepare(sql)),
    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      // the runtime's batch takes its own statements, never the wrappers
      const rs = await db.batch<T>(statements.map((s) => (s instanceof Stmt ? s.inner : s)));
      for (const r of rs) note(r);
      return rs;
    },
  } as SqlDatabase;
}

/** Count this env's D1 writes toward the budget (a no-op when the guard is off, or once installed). */
export function meterWrites(env: Env): void {
  if (writeBudget(env) <= 0 || (env.DB as { [METERED]?: boolean })[METERED]) return;
  env.DB = metered(env.DB, meterOf(env));
}

/** The counter lives in the live room the ingest already dispatches to. */
const roomOf = (env: Env) => env.ROOMS.get(env.ROOMS.idFromName(LIVE_REGION));

async function viewFrom(res: Response): Promise<BudgetView | null> {
  if (res.status !== 200) return null;
  const v = (await res.json().catch(() => null)) as BudgetView | null;
  return v && typeof v.used === "number" && typeof v.level === "string" ? v : null;
}

/**
 * The level the ingest acts on: the last one the room answered, when it is under a minute old and from
 * today; otherwise one read of the room (no D1 access). A room that cannot answer counts as `ok`: the guard
 * never costs a write because its own bookkeeping failed.
 */
export async function budgetLevel(env: Env): Promise<BudgetLevel> {
  const budget = writeBudget(env);
  if (budget <= 0) return "off";
  meterWrites(env);
  const m = meterOf(env);
  const t = Date.now();
  if (m.view && m.view.day === utcDay(t) && t - m.at < LEVEL_TTL_MS) return levelOf(m.view.used, budget);
  try {
    const v = await viewFrom(await roomOf(env).fetch(new Request(`https://room/budget?limit=${budget}`)));
    if (v) {
      m.view = v;
      m.at = t;
      return levelOf(v.used, budget);
    }
  } catch (e) {
    console.error("write budget:", (e as Error).message);
  }
  return "ok";
}

/**
 * The budget part of a live dispatch: the pending rows handed to the counter with it, or null when the
 * guard is off. {@link settleDispatch} reads the room's answer.
 */
export function dispatchBudget(env: Env): { add: number; limit: number } | null {
  const limit = writeBudget(env);
  if (limit <= 0) return null;
  const m = meterOf(env);
  const add = m.pending;
  m.pending = 0;
  return { add, limit };
}

/** Remember the view a dispatch answered; if the room did not take the count, keep it pending. */
export async function settleDispatch(env: Env, sent: { add: number } | null, res: Response | null): Promise<void> {
  if (!sent) return;
  const m = meterOf(env);
  const v = res ? await viewFrom(res) : null;
  if (!v) {
    m.pending += sent.add;
    return;
  }
  m.view = v;
  m.at = Date.now();
}

/** Hand the pending rows to the counter outside an ingest (the scheduled jobs); `mailed` marks alerts sent. */
async function flush(env: Env, mailed?: string[]): Promise<BudgetView | null> {
  const limit = writeBudget(env);
  if (limit <= 0) return null;
  const m = meterOf(env);
  const add = m.pending;
  m.pending = 0;
  try {
    const v = await viewFrom(
      await roomOf(env).fetch(
        new Request("https://room/budget", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ add, limit, ...(mailed ? { mailed } : {}) }),
        }),
      ),
    );
    if (v) {
      m.view = v;
      m.at = Date.now();
      return v;
    }
  } catch (e) {
    console.error("write budget:", (e as Error).message);
  }
  m.pending += add;
  return null;
}

/** The scheduled jobs' writes, handed to the counter when they finish. */
export async function flushWrites(env: Env): Promise<void> {
  await flush(env);
}

/** The admin status: the counter's view, or `off` when the guard is off. */
export async function budgetStatus(env: Env): Promise<BudgetView | { level: "off"; budget: 0; used: null }> {
  if (writeBudget(env) <= 0) return { level: "off", budget: 0, used: null };
  return (await flush(env)) ?? { day: utcDay(Date.now()), used: 0, budget: writeBudget(env), level: "ok", alerts: [] };
}

const pct = (a: BudgetAlert) => `${a.threshold} %`;

/** The digest mail for the alerts not yet mailed. */
function composeBudgetDigest(alerts: BudgetAlert[], budget: number): { subject: string; text: string } {
  const top = Math.max(...alerts.map((a) => a.threshold));
  const subject = `aprscaching — D1 writes reached ${top} % of the daily budget`;
  const lines = alerts.map(
    (a) =>
      `• ${a.day}: ${pct(a)} of ${budget.toLocaleString("en")} rows reached at ${new Date(a.at).toISOString().slice(11, 16)} UTC — ${
        a.threshold === 100
          ? "only protected stations, RF hearings, finds, accounts and federation data are stored"
          : "the raw packet log is paused and unprotected stations store fewer fixes"
      }`,
  );
  const text =
    `This instance's D1 writes crossed its daily write budget (D1_DAILY_WRITE_BUDGET):\n\n${lines.join("\n")}\n\n` +
    `The count starts again at 00:00 UTC. Live map traffic is unaffected. Raise the budget, narrow the APRS-IS ` +
    `filter, or move to the Self-host shape if this happens often. The Instance admin page shows today's count.`;
  return { subject, text };
}

/** The email addresses of the sysops: accounts holding a control-verified ADMIN_CALLSIGNS call. */
async function sysopEmails(env: Env): Promise<string[]> {
  const out = new Set<string>();
  for (const call of adminCalls(env)) {
    const base = baseCall(call);
    if (!(await isCallsignVerified(env, base))) continue;
    const rows = (
      await env.DB.prepare(
        `SELECT DISTINCT a.email AS email FROM account_callsigns c JOIN accounts a ON a.account_id = c.account_id
          WHERE c.callsign = ? AND a.email IS NOT NULL`,
      )
        .bind(base)
        .all<{ email: string }>()
    ).results;
    for (const r of rows) out.add(r.email);
  }
  return [...out];
}

/**
 * Nightly: mail the sysops the budget alerts no digest has carried yet. An alert is marked mailed only once
 * a mail went out, so an instance without email keeps showing it on the admin banner until it ages out.
 */
export async function runBudgetDigest(env: Env): Promise<void> {
  const budget = writeBudget(env);
  if (budget <= 0) return;
  const view = await flush(env);
  const due = view?.alerts.filter((a) => !a.mailed) ?? [];
  if (!due.length) return;
  const to = await sysopEmails(env);
  const { subject, text } = composeBudgetDigest(due, budget);
  let sent = false;
  for (const addr of to) sent = (await sendEmail(env, addr, subject, text)) || sent;
  if (sent) await flush(env, due.map(alertKey));
  else console.log(`write budget digest (not mailed): ${due.map(alertKey).join(", ")}`);
}
