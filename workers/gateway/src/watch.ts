/**
 * watch.ts — watchlist + alerts (docs/20 §4, W1). An operator watches callsigns (per account); when a
 * watched call is heard on the network — and especially near a cache — an in-app alert is recorded.
 * That in-app feed is the ADR-4b fallback; push/email delivery layers on top later. Watched calls are
 * keyed by account (ADR-2), so they survive a callsign change.
 *
 *   GET    /api/watch            list my watched calls + unseen alert count
 *   POST   /api/watch            add { callsign }
 *   DELETE /api/watch/:callsign  remove
 *   GET    /api/watch/alerts     my recent alerts (newest first)
 *   POST   /api/watch/seen       mark all my alerts seen
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionCallsign } from "./auth.js";
import { pushAlert } from "./notify.js";
import { parsePage, keyset, paginate } from "./paging.js";

const now = () => Math.floor(Date.now() / 1000);
const base = (c: string) => c.toUpperCase().split("-")[0]!;
const HEARD_THROTTLE_SEC = 3600;     // at most one "heard" alert per watched call per hour
const NEAR_CACHE_DEG = 0.0045;       // ~500 m bounding box for the near-a-cache tie-in

/** The account behind the current session (resolved from its callsign), or null if signed out. */
export async function sessionAccountId(req: Request, env: Env): Promise<string | null> {
  const cs = await sessionCallsign(req, env);
  if (!cs) return null;
  const a = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = ?").bind(base(cs)).first<{ account_id: string }>();
  if (a) return a.account_id;
  const b = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign = ?").bind(cs.toUpperCase()).first<{ account_id: string }>();
  return b?.account_id ?? null;
}

export async function handleWatchList(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in to manage your watchlist" }, { status: 401 });
  const calls = (await env.DB.prepare("SELECT callsign, added_at AS addedAt FROM watch_calls WHERE account_id = ? ORDER BY callsign").bind(acct).all<{ callsign: string }>()).results;
  const unseen = (await env.DB.prepare("SELECT COUNT(*) AS n FROM watch_alerts WHERE account_id = ? AND seen = 0").bind(acct).first<{ n: number }>())?.n ?? 0;
  return json({ watching: calls, unseen });
}

export async function handleWatchAdd(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in to manage your watchlist" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = base(String(callsign ?? "").trim());
  if (!/^[A-Z0-9]{3,}$/.test(cs)) return json({ error: "a valid callsign is required" }, { status: 400 });
  await env.DB.prepare("INSERT OR IGNORE INTO watch_calls (account_id, callsign, added_at) VALUES (?,?,?)").bind(acct, cs, now()).run();
  return json({ ok: true, callsign: cs }, { status: 201 });
}

export async function handleWatchRemove(req: Request, env: Env, callsign: string): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in to manage your watchlist" }, { status: 401 });
  await env.DB.prepare("DELETE FROM watch_calls WHERE account_id = ? AND callsign = ?").bind(acct, base(callsign)).run();
  return json({ ok: true });
}

export async function handleWatchAlerts(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in to see your alerts" }, { status: 401 });
  const pg = parsePage(new URL(req.url), 50, 200);
  const ks = keyset(pg.cursor, "ts", "id");
  const rows = (await env.DB.prepare(
    `SELECT id, callsign, kind, detail, cache_id AS cacheId, lat, lon, ts, seen FROM watch_alerts
       WHERE account_id = ?${ks.sql} ORDER BY ts DESC, id DESC LIMIT ?`,
  ).bind(acct, ...ks.binds, pg.limit + 1).all<{ id: number; ts: number; seen: number }>()).results;
  const page = paginate(rows, pg.limit, (r) => ({ primary: r.ts, id: r.id }));
  return json({ alerts: page.items.map((r) => ({ ...r, seen: r.seen === 1 })), nextCursor: page.nextCursor, hasMore: page.hasMore });
}

export async function handleWatchSeen(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  await env.DB.prepare("UPDATE watch_alerts SET seen = 1 WHERE account_id = ? AND seen = 0").bind(acct).run();
  return json({ ok: true });
}

/**
 * Ingest hook: raise alerts for any watched callsign just heard. Cheap when nobody watches (one
 * indexed lookup over the heard set); throttled to one "heard" per call/account/hour; a position near
 * a known cache upgrades the alert to "near_cache". Best-effort — never blocks ingest.
 */
export async function recordWatchHeard(env: Env, heard: { src: string; lat: number; lon: number }[]): Promise<void> {
  if (!heard.length) return;
  const pos = new Map<string, { lat: number; lon: number }>();
  for (const h of heard) pos.set(base(h.src), { lat: h.lat, lon: h.lon });
  const calls = [...pos.keys()];
  const watchers = (await env.DB.prepare(
    `SELECT account_id AS acct, callsign FROM watch_calls WHERE callsign IN (${calls.map(() => "?").join(",")})`,
  ).bind(...calls).all<{ acct: string; callsign: string }>()).results;
  if (!watchers.length) return;

  const t = now();
  for (const w of watchers) {
    const recent = await env.DB.prepare("SELECT 1 AS x FROM watch_alerts WHERE account_id = ? AND callsign = ? AND ts > ? LIMIT 1")
      .bind(w.acct, w.callsign, t - HEARD_THROTTLE_SEC).first();
    if (recent) continue;
    const p = pos.get(w.callsign)!;
    const cache = await env.DB.prepare(
      `SELECT id, code, title FROM caches WHERE status != 'archived' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
         ORDER BY (lat-?)*(lat-?)+(lon-?)*(lon-?) LIMIT 1`,
    ).bind(p.lat - NEAR_CACHE_DEG, p.lat + NEAR_CACHE_DEG, p.lon - NEAR_CACHE_DEG, p.lon + NEAR_CACHE_DEG, p.lat, p.lat, p.lon, p.lon)
      .first<{ id: number; code: string; title: string }>();
    const detail = cache ? `${w.callsign} heard near ${cache.code} — ${cache.title}` : `${w.callsign} heard on the network`;
    await env.DB.prepare("INSERT INTO watch_alerts (account_id, callsign, kind, detail, cache_id, lat, lon, ts) VALUES (?,?,?,?,?,?,?,?)")
      .bind(w.acct, w.callsign, cache ? "near_cache" : "heard", detail, cache?.id ?? null, p.lat, p.lon, t).run();
    // ADR-4b: best-effort web push now; the email digest batches the rest on a schedule
    try { await pushAlert(env, w.acct); } catch { /* best-effort */ }
  }
}
