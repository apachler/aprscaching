import type { Env } from "./env.js";
import { json } from "./index.js";
import {
  CreateCacheRequest, UpdateCacheRequest, LogRequest,
  type CacheSummary, type CacheDetail, type CacheLogEntry,
} from "@aprsweb/shared";
import { verifyFind, DEFAULT_POLICY, type CacheRow, type PositionRow } from "./verify.js";
import { sessionCallsign } from "./auth.js";
import { maybeAnnounceFind } from "./announce.js";

// ---- D1 row shapes (snake_case) ----
interface CacheDbRow {
  id: number; code: string; owner_call: string; title: string; type: string;
  status: string; difficulty: number; terrain: number; lat: number | null; lon: number | null;
  station_call: string | null; source: string; external_id: string | null;
  hint: string | null; description: string | null; min_trust: string | null;
  created_at: number; updated_at: number;
}
interface LogDbRow {
  id: number; cache_id: number; logger_call: string; ts: number; log_type: string;
  verified: number; tier: string | null; verify_method: string | null;
  distance_m: number | null; comment: string | null;
}

function toSummary(r: CacheDbRow): CacheSummary {
  return {
    id: r.id, code: r.code, ownerCall: r.owner_call, title: r.title,
    type: r.type as CacheSummary["type"], status: r.status as CacheSummary["status"],
    difficulty: r.difficulty, terrain: r.terrain, lat: r.lat, lon: r.lon,
    stationCall: r.station_call, source: r.source,
    minTrust: (r.min_trust as "A" | "B" | null) ?? null,
  };
}
function toLogEntry(r: LogDbRow): CacheLogEntry {
  return {
    id: r.id, cacheId: r.cache_id, loggerCall: r.logger_call, ts: r.ts,
    logType: r.log_type as CacheLogEntry["logType"], verified: r.verified === 1,
    tier: (r.tier as CacheLogEntry["tier"]) ?? null, verifyMethod: r.verify_method,
    distanceM: r.distance_m, comment: r.comment,
  };
}

/** The acting callsign: a signed-in session wins; otherwise the (advisory) body callsign. */
async function actor(req: Request, env: Env, fallback?: string): Promise<string | null> {
  const s = await sessionCallsign(req, env);
  if (s) return s.toUpperCase();
  return fallback ? fallback.toUpperCase() : null;
}

// ---------------------------------------------------------------- list (map layer)
export async function handleCachesInBBox(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const [minLon, minLat, maxLon, maxLat] = (u.searchParams.get("bbox") ?? "-180,-90,180,90")
    .split(",").map(Number);
  if ([minLon, minLat, maxLon, maxLat].some(Number.isNaN))
    return json({ error: "bad bbox" }, { status: 400 });
  const rows = await env.DB.prepare(
    `SELECT * FROM caches
     WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
       AND status != 'archived' LIMIT 1000`,
  ).bind(minLat, maxLat, minLon, maxLon).all<CacheDbRow>();
  return json({ caches: rows.results.map(toSummary) });
}

// ---------------------------------------------------------------- detail + logbook
export async function handleCacheDetail(req: Request, env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
  if (!row) return json({ error: "no such cache" }, { status: 404 });
  const logs = await env.DB.prepare(
    "SELECT * FROM cache_logs WHERE cache_id = ? ORDER BY ts DESC LIMIT 50",
  ).bind(id).all<LogDbRow>();
  const finds = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id = ? AND log_type = 'found' AND verified = 1",
  ).bind(id).first<{ n: number }>();
  const detail: CacheDetail = {
    ...toSummary(row),
    hint: row.hint, description: row.description, externalId: row.external_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    finds: finds?.n ?? 0,
    logs: logs.results.map(toLogEntry),
  };
  return json({ cache: detail });
}

// ---------------------------------------------------------------- create ("hide a cache")
export async function handleCreateCache(req: Request, env: Env): Promise<Response> {
  const parsed = CreateCacheRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;

  const owner = await actor(req, env, b.ownerCall);
  if (!owner) return json({ error: "owner callsign required (sign in or pass ownerCall)" }, { status: 401 });

  const now = Math.floor(Date.now() / 1000);
  const tmpCode = `__minting__${crypto.randomUUID()}`;
  try {
    const ins = await env.DB.prepare(
      `INSERT INTO caches
         (code, owner_call, title, type, status, difficulty, terrain, lat, lon,
          station_call, source, hint, description, min_trust, created_at, updated_at)
       VALUES (?,?,?,?, 'active', ?,?,?,?, ?, 'native', ?,?,?, ?,?)`,
    ).bind(
      tmpCode, owner, b.title, b.type, b.difficulty, b.terrain, b.lat, b.lon,
      b.stationCall ?? null, b.hint ?? null, b.description ?? null, b.minTrust ?? null, now, now,
    ).run();
    const id = Number(ins.meta.last_row_id);
    const code = b.code ?? `AC-${String(id).padStart(4, "0")}`;
    await env.DB.prepare("UPDATE caches SET code = ? WHERE id = ?").bind(code, id).run();
    const row = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
    return json({ cache: toSummary(row!) }, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/UNIQUE/i.test(msg)) return json({ error: "code already exists" }, { status: 409 });
    return json({ error: "create failed", detail: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------- update (owner CRUD)
export async function handleUpdateCache(req: Request, env: Env, id: number): Promise<Response> {
  const parsed = UpdateCacheRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;

  const existing = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
  if (!existing) return json({ error: "no such cache" }, { status: 404 });

  const who = await actor(req, env, b.ownerCall);
  if (!who || who !== existing.owner_call.toUpperCase())
    return json({ error: "only the owner may edit this cache" }, { status: 403 });

  // merge: undefined keeps existing
  const m = {
    title: b.title ?? existing.title,
    type: b.type ?? existing.type,
    status: b.status ?? existing.status,
    difficulty: b.difficulty ?? existing.difficulty,
    terrain: b.terrain ?? existing.terrain,
    lat: b.lat ?? existing.lat,
    lon: b.lon ?? existing.lon,
    station_call: b.stationCall ?? existing.station_call,
    hint: b.hint ?? existing.hint,
    description: b.description ?? existing.description,
    min_trust: b.minTrust ?? existing.min_trust,
  };
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE caches SET title=?, type=?, status=?, difficulty=?, terrain=?, lat=?, lon=?,
       station_call=?, hint=?, description=?, min_trust=?, updated_at=? WHERE id=?`,
  ).bind(m.title, m.type, m.status, m.difficulty, m.terrain, m.lat, m.lon,
         m.station_call, m.hint, m.description, m.min_trust, now, id).run();
  const row = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
  return json({ cache: toSummary(row!) });
}

// ---------------------------------------------------------------- log (found/DNF/note/…)
export async function handleLog(req: Request, env: Env, cacheIdFromPath?: number): Promise<Response> {
  const parsed = LogRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error?.issues }, { status: 400 });
  const { comment, appGeo, logType } = parsed.data;
  const cacheId = cacheIdFromPath ?? parsed.data.cacheId;
  if (cacheId == null) return json({ error: "cacheId required" }, { status: 400 });

  // logging stays easy: prefer the signed-in callsign; fall back to the claimed one.
  const sessionCall = await sessionCallsign(req, env);
  const loggerCall = (sessionCall ?? parsed.data.loggerCall).toUpperCase();
  const accountVerified = sessionCall != null; // session => passkey-bound account

  const cache = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(cacheId)
    .first<CacheRow & { code: string; title: string }>();
  if (!cache) return json({ error: "no such cache" }, { status: 404 });

  const now = Math.floor(Date.now() / 1000);

  // Only `found` logs are presence-verified; DNF/note/maintenance are plain records.
  if (logType !== "found") {
    await env.DB.prepare(
      `INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method, comment)
       VALUES (?,?,?,?, 0, NULL, 'manual', ?)`,
    ).bind(cacheId, loggerCall, now, logType, comment ?? null).run();
    return json({ logged: true, logType, accountVerified, verified: false });
  }

  const since = now - DEFAULT_POLICY.windowSec;
  const lp = await env.DB.prepare(
    "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND source != 'service' ORDER BY ts DESC LIMIT 500",
  ).bind(loggerCall, since).all<PositionRow>();

  let cacheStationPositions: PositionRow[] | undefined;
  if (cache.type === "aprs_living" && cache.station_call) {
    const cs = await env.DB.prepare(
      "SELECT * FROM positions WHERE callsign = ? AND ts >= ? ORDER BY ts DESC LIMIT 500",
    ).bind(cache.station_call, since).all<PositionRow>();
    cacheStationPositions = cs.results;
  }

  const result = verifyFind(cache, appGeo, {
    loggerPositions: lp.results, cacheStationPositions, loggerOwnIgates: new Set(),
  });

  await env.DB.prepare(
    `INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method, matched_position_id, distance_m, comment)
     VALUES (?,?,?, 'found', ?,?,?,?,?,?)`,
  ).bind(cacheId, loggerCall, now, result.verified ? 1 : 0, result.tier, result.method,
         result.matchedPositionId ?? null, result.distanceM ?? null, comment ?? null).run();

  // optional: announce to APRS-IS (opt-in + verified callsign only)
  const announced = await maybeAnnounceFind(env, loggerCall, cache.code, cache.title);

  return json({ logged: true, logType, accountVerified, announced, ...result });
}

/** Back-compat alias for the original /api/logs/find route. */
export const handleLogFind = handleLog;
