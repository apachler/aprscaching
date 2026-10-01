// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Federation catch-up: a spoke that was offline (typically a Pocket) resumes pushing to its hub promptly
 * and visibly.
 *
 * - After a push fails for a network reason, the spoke probes the hub's `/health?live` with exponential
 *   backoff (30 s doubling to 10 min, ±20 % jitter) instead of waiting for the next sync interval; the
 *   first answer runs the sync at once and re-reads the hub's marks (fedpush.ts).
 * - While a feed still has pages past one cycle's cap, the next cycle runs a few seconds later.
 * - The operator sees how pushing stands (last push, records waiting, offline since) and starts a sync by
 *   hand; a hub sees per spoke when it last submitted, and marks a quiet spoke stale. Display only: none
 *   of it changes trust.
 *
 * The Worker runs on its cron and needs none of the scheduling; Node and Bun drive it from host.ts.
 */
import type { Env } from "./env.js";
import { json, runFrequentSync, type FrequentSyncResult } from "./app.js";
import { requireSysop } from "./admin.js";
import { fedFetch, trimTrailingSlashes } from "./fetchguard.js";
import { pushBacklog } from "./fedpush.js";
import type { ExecCtx } from "./runtime.js";
import { nowS } from "./util/time.js";

const PROBE_FIRST_MS = 30_000;
const PROBE_MAX_MS = 10 * 60_000;
/** The pause before the next cycle while a backlog remains. */
const BACKLOG_DELAY_MS = 5_000;
/** A spoke that has not submitted for this long is marked stale on the hub (FED_SPOKE_STALE_HOURS). */
const SPOKE_STALE_HOURS = 24;

/** The wait before probe number `attempt` (0-based): 30 s doubling to 10 min, ±20 % jitter. */
export function probeDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(PROBE_FIRST_MS * 2 ** Math.max(0, attempt), PROBE_MAX_MS);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/** Does the hub answer? A cheap liveness request that touches no database. */
async function probeHub(
  env: Env,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fedFetch(env, u, i),
): Promise<boolean> {
  if (!env.FED_HUB_URL) return false;
  try {
    const res = await fetchFn(`${trimTrailingSlashes(env.FED_HUB_URL)}/health?live`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

/**
 * The Node/Bun catch-up loop around the frequent sync. `after` takes each sync's result and schedules
 * the follow-up: probes while the hub is unreachable, an early cycle while a backlog remains, nothing
 * otherwise (the regular interval carries on).
 */
export function catchUp(
  env: Env,
  deps: {
    timers?: Timers;
    sync?: (opts: { resync?: boolean }) => Promise<FrequentSyncResult>;
    probe?: () => Promise<boolean>;
    rand?: () => number;
  } = {},
) {
  const timers: Timers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const sync = deps.sync ?? ((opts) => runFrequentSync(env, opts));
  const probe = deps.probe ?? (() => probeHub(env));
  let timer: unknown = null;
  let attempt = 0;
  const later = (fn: () => void, ms: number) => {
    if (timer != null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  const run = async (opts: { resync?: boolean } = {}) => after(await sync(opts));
  const probeOnce = async () => {
    if (await probe()) {
      attempt = 0;
      await run({ resync: true }); // back online: read the hub's marks again and catch up now
    } else later(() => void probeOnce().catch(log), probeDelayMs(++attempt, deps.rand));
  };
  const log = (e: unknown) => console.error("federation catch-up:", e);
  function after(r: FrequentSyncResult): void {
    if (r.push?.failure === "network") later(() => void probeOnce().catch(log), probeDelayMs(attempt, deps.rand));
    else if (r.push?.backlog) {
      attempt = 0;
      later(() => void run().catch(log), BACKLOG_DELAY_MS);
    } else attempt = 0;
  }
  return { after, run };
}

/**
 * GET /api/admin/federation/sync — how pushing to the hub stands (when this instance is a spoke) and when
 * each spoke last submitted (when it is a hub). Sysop or the operator secret.
 */
export async function handleSyncStatus(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const hubUrl = env.FED_HUB_URL ? trimTrailingSlashes(env.FED_HUB_URL) : null;
  let hub: Record<string, unknown> | null = null;
  if (hubUrl) {
    const st = await env.DB.prepare("SELECT * FROM fed_hub_status WHERE hub = ?").bind(hubUrl).first<{
      last_attempt_at: number | null;
      last_ok_at: number | null;
      last_error: string | null;
      offline_since: number | null;
    }>();
    const waiting = await pushBacklog(env, hubUrl);
    hub = {
      url: hubUrl,
      lastAttemptAt: st?.last_attempt_at ?? null,
      lastOkAt: st?.last_ok_at ?? null,
      lastError: st?.last_error ?? null,
      offlineSince: st?.offline_since ?? null,
      waiting,
      waitingCap: 1000,
    };
  }
  const staleHours = Number(env.FED_SPOKE_STALE_HOURS) > 0 ? Number(env.FED_SPOKE_STALE_HOURS) : SPOKE_STALE_HOURS;
  const rows = (
    await env.DB.prepare(
      `SELECT m.instance, MAX(m.submitted_at) AS last_submit_at,
              MAX(CASE WHEN m.type = 'cache' THEN m.cursor END) AS newest_cache_change, p.trust
         FROM fed_submit_marks m LEFT JOIN fed_peers p ON p.url = 'submit:' || m.instance
        GROUP BY m.instance ORDER BY m.instance`,
    ).all<{ instance: string; last_submit_at: number; newest_cache_change: number | null; trust: string | null }>()
  ).results;
  const t = nowS();
  const spokes = rows.map((r) => ({
    instance: r.instance,
    trust: r.trust,
    lastSubmitAt: r.last_submit_at,
    newestCacheChange: r.newest_cache_change,
    stale: t - r.last_submit_at > staleHours * 3600,
  }));
  return json({ hub, spokes, staleHours });
}

/**
 * POST /api/admin/federation/sync — Sync now: pull from the peers and push to the hub at once, reading the
 * hub's marks again. It runs in the background; the status endpoint shows the outcome.
 */
export async function handleSyncNow(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  ctx.waitUntil(runFrequentSync(env, { resync: true }).catch((e) => console.error("sync now:", (e as Error).message)));
  return json({ ok: true, started: true }, { status: 202 });
}
