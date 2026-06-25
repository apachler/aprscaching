import type { Env } from "./env.js";
import { json } from "./app.js";
import {
  CreateCacheRequest, UpdateCacheRequest, LogRequest,
  type CacheSummary, type CacheDetail, type CacheLogEntry, type MapCache,
} from "@aprsweb/shared";
import { verifyFind, DEFAULT_POLICY, type CacheRow, type PositionRow } from "./verify.js";
import { sessionCallsign } from "./auth.js";
import { maybeAnnounceFind } from "./announce.js";
import { queryPeerCorroboration } from "./corroborate.js";
import { verifyAuthorship, isKeyRegistered } from "./keys.js";
import { awardFindBadges, awardHideBadge, cacheHealth, favoritesInfo } from "./community.js";
import { stageCount } from "./stages.js";

// ---- D1 row shapes (snake_case) ----
interface CacheDbRow {
  id: number; code: string; owner_call: string; title: string; type: string;
  status: string; difficulty: number; terrain: number; lat: number | null; lon: number | null;
  station_call: string | null; source: string; external_id: string | null;
  hint: string | null; description: string | null; min_trust: string | null;
  source_url: string | null; source_name: string | null;
  created_at: number; updated_at: number;
}
interface LogDbRow {
  id: number; cache_id: number; logger_call: string; ts: number; log_type: string;
  verified: number; tier: string | null; verify_method: string | null;
  distance_m: number | null; comment: string | null; corroborated_by: string | null;
  signer_key: string | null;
}

function toSummary(r: CacheDbRow): CacheSummary {
  return {
    id: r.id, code: r.code, ownerCall: r.owner_call, title: r.title,
    type: r.type as CacheSummary["type"], status: r.status as CacheSummary["status"],
    difficulty: r.difficulty, terrain: r.terrain, lat: r.lat, lon: r.lon,
    stationCall: r.station_call, source: r.source,
    sourceName: r.source_name, sourceUrl: r.source_url,
    minTrust: (r.min_trust as "A" | "B" | null) ?? null,
  };
}
function toLogEntry(r: LogDbRow): CacheLogEntry {
  return {
    id: r.id, cacheId: r.cache_id, loggerCall: r.logger_call, ts: r.ts,
    logType: r.log_type as CacheLogEntry["logType"], verified: r.verified === 1,
    tier: (r.tier as CacheLogEntry["tier"]) ?? null, verifyMethod: r.verify_method,
    distanceM: r.distance_m, comment: r.comment, corroboratedBy: r.corroborated_by,
    signerKey: r.signer_key,
  };
}

function ingestOk(req: Request, env: Env): boolean { return (req.headers.get("x-ingest-secret") ?? "") === env.INGEST_SECRET; }
function baseCall(c: string): string { return c.toUpperCase().split("-")[0] ?? ""; }

/**
 * The AUTHORISED acting callsign for a write (hide / log): a signed-in passkey session wins;
 * otherwise the body callsign IS allowed only when the request carries the ingest secret — i.e.
 * the trusted backend / APRS-originated path (an RF-heard find attributed to its callsign). A bare
 * web request with neither is rejected (null → 401). This is what gates web logging behind sign-in
 * without breaking the over-APRS logging path.
 */
export async function actor(req: Request, env: Env, fallback?: string): Promise<string | null> {
  const s = await sessionCallsign(req, env);
  if (s) return s.toUpperCase();
  if (ingestOk(req, env) && fallback) return fallback.toUpperCase();
  return null;
}

interface RemoteCacheRow {
  global_id: string; origin: string; code: string; owner_call: string; title: string; type: string;
  status: string; difficulty: number; terrain: number; lat: number | null; lon: number | null;
  station_call: string | null; source: string; external_id: string | null; min_trust: string | null;
  origin_trust: string; // joined from fed_peers (T3.1): 'trusted' | 'unvetted' (blocked is filtered out)
}

function nativeMapCache(r: CacheDbRow, instance: string): MapCache {
  return {
    globalId: `${instance}:cache:${r.id}`, id: r.id, code: r.code, ownerCall: r.owner_call,
    title: r.title, type: r.type as MapCache["type"], status: r.status as MapCache["status"],
    difficulty: r.difficulty, terrain: r.terrain, lat: r.lat, lon: r.lon,
    origin: instance, mirrored: false, originTrust: "native",
    source: r.source, sourceName: r.source_name, sourceUrl: r.source_url,
  };
}
function remoteMapCache(r: RemoteCacheRow): MapCache {
  return {
    globalId: r.global_id, id: null, code: r.code, ownerCall: r.owner_call, title: r.title,
    type: r.type as MapCache["type"], status: r.status as MapCache["status"],
    difficulty: r.difficulty, terrain: r.terrain, lat: r.lat, lon: r.lon,
    origin: r.origin, mirrored: true, originTrust: r.origin_trust === "trusted" ? "trusted" : "unvetted",
    source: r.source, sourceName: null, sourceUrl: null,
  };
}

// ---------------------------------------------------------------- list (map layer)
// Aggregates native caches + caches mirrored from federation peers (F2), each tagged with its origin's
// trust (T3.1). Trust policy: native always shown; `trusted`-origin mirrors shown by default; `unvetted`
// (auto-discovered, T1.1) hidden unless `?includeUnvetted=1`; `blocked` never surfaced. The trust is a
// read-time join to fed_peers, so promoting/blocking a peer takes effect immediately, no re-mirror.
export async function handleCachesInBBox(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const [minLon, minLat, maxLon, maxLat] = (u.searchParams.get("bbox") ?? "-180,-90,180,90")
    .split(",").map(Number);
  if ([minLon, minLat, maxLon, maxLat].some(Number.isNaN))
    return json({ error: "bad bbox" }, { status: 400 });
  const instance = env.INSTANCE ?? u.host;
  const includeUnvetted = u.searchParams.get("includeUnvetted") === "1" || u.searchParams.get("network") === "all";

  const native = await env.DB.prepare(
    `SELECT * FROM caches
     WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND status != 'archived' LIMIT 1000`,
  ).bind(minLat, maxLat, minLon, maxLon).all<CacheDbRow>();
  // origin trust defaults to 'unvetted' when the origin peer is unknown (e.g. removed) — hidden by default.
  const remote = await env.DB.prepare(
    `SELECT rc.*, COALESCE(fp.trust, 'unvetted') AS origin_trust
       FROM remote_caches rc
       LEFT JOIN fed_peers fp ON fp.instance = rc.origin
      WHERE rc.lat BETWEEN ? AND ? AND rc.lon BETWEEN ? AND ? AND rc.status != 'archived'
        AND COALESCE(fp.trust, 'unvetted') != 'blocked'
        AND (? = 1 OR COALESCE(fp.trust, 'unvetted') = 'trusted')
      LIMIT 1000`,
  ).bind(minLat, maxLat, minLon, maxLon, includeUnvetted ? 1 : 0).all<RemoteCacheRow>();

  const caches: MapCache[] = [
    ...native.results.map((r) => nativeMapCache(r, instance)),
    ...remote.results.map(remoteMapCache),
  ];
  return json({ caches, includeUnvetted });
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
  const who = new URL(req.url).searchParams.get("callsign");
  const health = await cacheHealth(env, id);
  const fav = await favoritesInfo(env, id, who);
  const stages = await stageCount(env, id);
  const detail: CacheDetail = {
    ...toSummary(row),
    hint: row.hint, description: row.description, externalId: row.external_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    finds: finds?.n ?? 0,
    logs: logs.results.map(toLogEntry),
    favorites: fav.favorites, favorited: fav.favorited,
    needsMaintenance: health.needsMaintenance, dnfStreak: health.dnfStreak, lastFound: health.lastFound,
    stageCount: stages,
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
    await awardHideBadge(env, owner); // M4: hider badges
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

  // Logging requires a signed-in session (web) OR the ingest secret (APRS/RF-originated finds,
  // attributed to the heard callsign and authorised by the trusted backend, not a cookie).
  const sessionCall = await sessionCallsign(req, env);
  let loggerCall: string;
  if (sessionCall) {
    loggerCall = sessionCall.toUpperCase();
    const claimed = parsed.data.loggerCall?.toUpperCase();
    if (claimed && baseCall(claimed) === baseCall(loggerCall)) loggerCall = claimed; // operate as an SSID of your own call
  } else if (ingestOk(req, env) && parsed.data.loggerCall) {
    loggerCall = parsed.data.loggerCall.toUpperCase();
  } else {
    return json({ error: "sign in to log a find" }, { status: 401 });
  }
  const accountVerified = sessionCall != null; // session => passkey-bound account

  const cache = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(cacheId)
    .first<CacheRow & { code: string; title: string }>();
  if (!cache) return json({ error: "no such cache" }, { status: 404 });

  const now = Math.floor(Date.now() / 1000);

  // Per-callsign authorship (F0): if the logger signed the log with their device key, verify it
  // (signature valid AND key registered to the callsign) and persist it as portable provenance.
  let signerKey: string | null = null, authorSig: string | null = null, signedAt: number | null = null;
  if (parsed.data.author) {
    const a = parsed.data.author;
    const instance = env.INSTANCE ?? new URL(req.url).host;
    const okSig = await verifyAuthorship({
      cache: cache.code, instance, logger: loggerCall, logType, at: a.signedAt,
      authorKey: a.authorKey, authorSig: a.authorSig,
    });
    if (!okSig) return json({ error: "invalid author signature" }, { status: 400 });
    if (!(await isKeyRegistered(env, loggerCall, a.authorKey)))
      return json({ error: "author key not registered to callsign" }, { status: 400 });
    signerKey = a.authorKey; authorSig = a.authorSig; signedAt = a.signedAt;
  }

  // Only `found` logs are presence-verified; DNF/note/maintenance are plain records.
  if (logType !== "found") {
    await env.DB.prepare(
      `INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method, comment, signer_key, author_sig, signed_at)
       VALUES (?,?,?,?, 0, NULL, 'manual', ?,?,?,?)`,
    ).bind(cacheId, loggerCall, now, logType, comment ?? null, signerKey, authorSig, signedAt).run();
    return json({ logged: true, logType, accountVerified, verified: false, signerKey });
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

  // F3: if we couldn't reach Tier A locally, ask peers whether the logger was independently
  // heard on RF near the cache (cross-instance corroboration). A hit upgrades the find to Tier A.
  let corroboratedBy: string | null = null;
  if (result.tier !== "A" && cache.lat != null && cache.lon != null) {
    const ev = await queryPeerCorroboration(env, {
      callsign: loggerCall, lat: cache.lat, lon: cache.lon,
      radiusM: DEFAULT_POLICY.radiusM, since, until: now,
    });
    if (ev) {
      corroboratedBy = ev.instance;
      result.tier = "A";
      result.method = "aprs_rf_peer";
      result.verified = true;            // A satisfies any cache min_trust
      result.distanceM = ev.distanceM;
      result.matchedPositionId = undefined;
      result.reason = undefined;
    }
  }

  await env.DB.prepare(
    `INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method, matched_position_id, distance_m, comment, corroborated_by, signer_key, author_sig, signed_at)
     VALUES (?,?,?, 'found', ?,?,?,?,?,?,?,?,?,?)`,
  ).bind(cacheId, loggerCall, now, result.verified ? 1 : 0, result.tier, result.method,
         result.matchedPositionId ?? null, result.distanceM ?? null, comment ?? null, corroboratedBy,
         signerKey, authorSig, signedAt).run();

  // M4: award find badges (idempotent; counts verified finds inside)
  if (result.verified) await awardFindBadges(env, loggerCall);

  // optional: announce to APRS-IS (opt-in + verified callsign only)
  const announced = await maybeAnnounceFind(env, loggerCall, cache.code, cache.title);

  return json({ logged: true, logType, accountVerified, announced, corroboratedBy, signerKey, ...result });
}

/** Back-compat alias for the original /api/logs/find route. */
export const handleLogFind = handleLog;
