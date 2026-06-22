import type { Env } from "./env.js";
import { json } from "./index.js";
import { LogFindRequest } from "@aprsweb/shared";
import { verifyFind, DEFAULT_POLICY, type CacheRow, type PositionRow } from "./verify.js";
import { sessionCallsign } from "./auth.js";
import { maybeAnnounceFind } from "./announce.js";

export async function handleCachesInBBox(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const [minLon, minLat, maxLon, maxLat] = (u.searchParams.get("bbox") ?? "0,0,0,0").split(",").map(Number);
  const rows = await env.DB.prepare(
    `SELECT c.* FROM caches c JOIN cache_rtree r ON r.id = c.id
     WHERE r.min_lat <= ? AND r.max_lat >= ? AND r.min_lon <= ? AND r.max_lon >= ?
       AND c.status = 'active' LIMIT 1000`,
  ).bind(maxLat, minLat, maxLon, minLon).all();
  return json({ caches: rows.results });
}

export async function handleLogFind(req: Request, env: Env): Promise<Response> {
  const parsed = LogFindRequest.safeParse(await req.json());
  if (!parsed.success) return json({ error: "bad request" }, { status: 400 });
  const { cacheId, comment, appGeo } = parsed.data;

  // logging stays easy: prefer the signed-in callsign; fall back to the claimed one.
  const sessionCall = await sessionCallsign(req, env);
  const loggerCall = (sessionCall ?? parsed.data.loggerCall).toUpperCase();
  const accountVerified = sessionCall != null; // session => passkey-bound account

  const cache = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(cacheId).first<CacheRow & { code: string; title: string }>();
  if (!cache) return json({ error: "no such cache" }, { status: 404 });

  const now = Math.floor(Date.now() / 1000);
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

  return json({ logged: true, accountVerified, announced, ...result });
}
