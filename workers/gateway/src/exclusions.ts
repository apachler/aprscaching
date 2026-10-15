// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * exclusions.ts — stations kept out on their licensee's objection. The privacy notice lets a licensee object
 * (GDPR Art. 21) to the processing of their station's on-air data; the sysop answers by listing the base call here.
 *
 *   GET    /api/admin/exclusions          the excluded calls, newest first
 *   GET    /api/admin/exclusions/:call    what adding the call would purge, and whether an account holds it
 *   POST   /api/admin/exclusions          exclude {callsign, category}: list the base call and purge its rows
 *   DELETE /api/admin/exclusions/:call    lift an exclusion
 *
 * Every route passes `requireSysop` (or the operator secret); hiding the surface in the web app is a convenience.
 *
 * An exclusion covers the base call and every SSID of it: the objection comes from the licensee. It reaches what
 * the station itself sent — its map entry, positions, raw packets, received messages it sent, weather readings
 * heard on the air, its MeshCom node and links, the node's heard list, a NET/ROM route to it and watch alerts raised
 * by hearing it. The ingest drops each later frame of the station before anything is stored, fanned out (the live
 * map, the heard stream) or acted on. A frame of another station that only names the excluded call in its path or as
 * an addressee is that other station's transmission and stays. Federation carries no station data, so no peer brings
 * it back. Accounts and finds are untouched: a member holding the call chose their own data here, and erasure is
 * their own tool. The per-port counters are aggregates without a callsign and stay too.
 *
 * The list is read on every ingest batch, so each runtime keeps it in memory for {@link CACHE_TTL_MS} per
 * database; a change through these routes clears that copy at once.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { nowS } from "./util/time.js";
import { requireSysop } from "./admin.js";
import { baseHolder, sessionIdentity } from "./auth.js";
import { actorOf, audit } from "./moderation.js";
import { serviceCall } from "./servicecall.js";

/** Why a call is excluded: the licensee objected (Art. 21), asked for erasure (Art. 17), or something else. */
export const EXCLUSION_CATEGORIES = ["objection", "erasure", "other"] as const;
type ExclusionCategory = (typeof EXCLUSION_CATEGORIES)[number];

/** How long a runtime keeps the list before reading it again. */
const CACHE_TTL_MS = 60_000;

const CALL_RE = /^[A-Z0-9]{3,9}$/;

/** The base call an exclusion names, from a call with or without an SSID, or null when it is no callsign. */
export function exclusionCall(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const base = baseCall(raw);
  return CALL_RE.test(base) && /[0-9]/.test(base) && /[A-Z]/.test(base) ? base : null;
}

/**
 * The calls one packet speaks for: its source, and for third-party traffic (`}` opens the information field) the
 * source of the packet it carries, which another station relayed for it.
 */
function sourcesOf(p: { src: string; payload: string }): string[] {
  if (!p.payload.startsWith("}")) return [p.src];
  const inner = /^\}([^>]{1,12})>/.exec(p.payload);
  return inner ? [p.src, inner[1]!] : [p.src];
}

/** Is the packet the excluded station's own: sent by it, under any SSID, or relayed for it as third-party traffic? */
export function excludedPacket(excluded: ReadonlySet<string>, p: { src: string; payload: string }): boolean {
  return excluded.size > 0 && sourcesOf(p).some((c) => excluded.has(baseCall(c)));
}

/** Is the call, under any SSID, excluded? */
export const isExcludedCall = (excluded: ReadonlySet<string>, call: string): boolean =>
  excluded.size > 0 && excluded.has(baseCall(call));

const cache = new WeakMap<object, { at: number; calls: Set<string> }>();

/**
 * The excluded base calls. A read that fails keeps the last list this runtime had (none before the first read),
 * so a database hiccup costs no ingest batch.
 */
export async function excludedCalls(env: Env): Promise<Set<string>> {
  const hit = cache.get(env.DB);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.calls;
  try {
    const rows = (await env.DB.prepare("SELECT callsign FROM excluded_calls").all<{ callsign: string }>()).results;
    const calls = new Set(rows.map((r) => r.callsign));
    cache.set(env.DB, { at: Date.now(), calls });
    return calls;
  } catch (e) {
    console.error("excluded calls:", (e as Error).message);
    return hit?.calls ?? new Set();
  }
}

/** One table the purge reaches: the columns naming the station, and a condition on its own rows. */
interface PurgeTarget {
  key: string;
  table: string;
  cols: string[];
  where?: string;
}

/**
 * What an exclusion purges, one entry per kind the confirm dialog names. Received messages the station sent go;
 * those others sent it, and what members sent from here, are theirs. Weather pushed by a member's own station is
 * account data; only readings heard on the air go. Watch alerts raised by hearing the station go with the hearing.
 */
export const PURGE_TARGETS: readonly PurgeTarget[] = [
  { key: "stations", table: "stations", cols: ["callsign"] },
  { key: "positions", table: "positions", cols: ["callsign"] },
  { key: "packets", table: "packets_recent", cols: ["callsign"] },
  { key: "messages", table: "messages", cols: ["from_call"], where: "direction = 'rx'" },
  {
    key: "weather",
    table: "sensor_readings",
    cols: ["station"],
    where: "(source IS NULL OR source IN ('rf', 'aprs_is'))",
  },
  { key: "meshcomNodes", table: "meshcom_nodes", cols: ["callsign"] },
  { key: "meshcomLinks", table: "meshcom_links", cols: ["from_call", "to_call"] },
  { key: "meshcomMessages", table: "meshcom_group_messages", cols: ["from_call"] },
  { key: "mheard", table: "node_mheard", cols: ["callsign"] },
  { key: "netromNodes", table: "netrom_nodes", cols: ["dest"] },
  { key: "watchAlerts", table: "watch_alerts", cols: ["callsign"], where: "kind IN ('heard', 'near_cache')" },
];

/** The WHERE clause and binds that pick a target's rows of `call`: the base call or any SSID of it, in any column. */
export function purgeWhere(t: PurgeTarget, call: string): { sql: string; binds: string[] } {
  const named = t.cols.map((c) => `${c} = ? OR ${c} LIKE ?`).join(" OR ");
  return {
    sql: t.where ? `(${named}) AND ${t.where}` : `(${named})`,
    binds: t.cols.flatMap(() => [call, `${call}-%`]),
  };
}

/** How many rows of each kind the instance holds of the station. */
async function purgeCounts(env: Env, call: string): Promise<Record<string, number>> {
  const rows = await env.DB.batch(
    PURGE_TARGETS.map((t) => {
      const w = purgeWhere(t, call);
      return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${w.sql}`).bind(...w.binds);
    }),
  );
  return Object.fromEntries(
    PURGE_TARGETS.map((t, i) => [t.key, Number((rows[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0)]),
  );
}

interface ExclusionRow {
  callsign: string;
  category: string;
  created_at: number;
  by_call: string | null;
  held: number;
}

async function handleList(env: Env): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT e.callsign, e.category, e.created_at, a.callsign AS by_call,
              EXISTS (SELECT 1 FROM account_callsigns h WHERE h.callsign = e.callsign) AS held
         FROM excluded_calls e LEFT JOIN accounts a ON a.account_id = e.created_by
        ORDER BY e.created_at DESC, e.callsign`,
    ).all<ExclusionRow>()
  ).results;
  return json({
    exclusions: rows.map((r) => ({
      callsign: r.callsign,
      category: r.category,
      createdAt: r.created_at,
      createdBy: r.by_call,
      held: !!r.held,
    })),
  });
}

/** What adding the call would do: the rows it purges, and whether a member holds it (the dialog warns then). */
async function handlePreview(env: Env, call: string): Promise<Response> {
  const excluded = await env.DB.prepare("SELECT 1 FROM excluded_calls WHERE callsign = ?").bind(call).first();
  return json({
    callsign: call,
    excluded: !!excluded,
    held: !!(await baseHolder(env, call)),
    counts: await purgeCounts(env, call),
  });
}

async function handleAdd(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const call = exclusionCall(b.callsign);
  if (!call) return json({ error: "a valid callsign is required" }, { status: 400 });
  const category = EXCLUSION_CATEGORIES.find((c): c is ExclusionCategory => c === b.category);
  if (!category) return json({ error: `category must be one of ${EXCLUSION_CATEGORIES.join(", ")}` }, { status: 400 });
  if (call === baseCall(serviceCall(env)))
    return json({ error: "the instance's own service call cannot be excluded" }, { status: 409 });
  if (await env.DB.prepare("SELECT 1 FROM excluded_calls WHERE callsign = ?").bind(call).first())
    return json({ error: "this callsign is already excluded" }, { status: 409 });
  const counts = await purgeCounts(env, call);
  const me = await sessionIdentity(req, env);
  const actor = await actorOf(req, env);
  // the listing and the purge commit together, so no batch stored between them survives a failure of either
  await env.DB.batch([
    env.DB.prepare("INSERT INTO excluded_calls (callsign, category, created_at, created_by) VALUES (?,?,?,?)").bind(
      call,
      category,
      nowS(),
      me?.accountId ?? null,
    ),
    ...PURGE_TARGETS.map((t) => {
      const w = purgeWhere(t, call);
      return env.DB.prepare(`DELETE FROM ${t.table} WHERE ${w.sql}`).bind(...w.binds);
    }),
    audit(env, { actor, action: "exclude", kind: "station", id: call, label: call, reason: category }),
  ]);
  cache.delete(env.DB);
  const held = !!(await baseHolder(env, call));
  return json({ ok: true, callsign: call, category, held, purged: counts }, { status: 201 });
}

async function handleLift(req: Request, env: Env, call: string): Promise<Response> {
  const had = await env.DB.prepare("DELETE FROM excluded_calls WHERE callsign = ? RETURNING category")
    .bind(call)
    .first<{ category: string }>();
  if (!had) return json({ error: "this callsign is not excluded" }, { status: 404 });
  cache.delete(env.DB);
  await audit(env, {
    actor: await actorOf(req, env),
    action: "include",
    kind: "station",
    id: call,
    label: call,
    reason: had.category,
  }).run();
  return json({ ok: true, callsign: call });
}

/** /api/admin/exclusions[/:call] — every route is the sysop's (or the operator secret's) alone. */
export async function handleAdminExclusions(req: Request, env: Env, rawCall?: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const m = req.method;
  if (rawCall === undefined) {
    if (m === "GET") return handleList(env);
    if (m === "POST") return handleAdd(req, env);
    return new Response("method not allowed", { status: 405 });
  }
  const call = exclusionCall(rawCall);
  if (!call) return json({ error: "a valid callsign is required" }, { status: 400 });
  if (m === "GET") return handlePreview(env, call);
  if (m === "DELETE") return handleLift(req, env, call);
  return new Response("method not allowed", { status: 405 });
}
