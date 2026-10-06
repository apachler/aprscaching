// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * readapi.ts — the public read API. A versioned, documented, read-only surface
 * under /api/v1 that reuses the existing read handlers behind a rate-limit gate. Free + per-IP
 * limited; a free key raises the limit and gates nothing. A signed-in account creates its keys under
 * Settings → Developer (apikeys.ts). The app's internal /api/* endpoints are untouched, so this can't regress
 * the app.
 *
 *   GET  /api/v1                      index: endpoint catalogue + limits + how to get a key
 *   GET  /api/v1/key                  the presented key's name, prefix, creation and last use
 *   GET  /api/v1/caches?bbox=         caches in a (capped) bbox
 *   GET  /api/v1/caches/:code         cache detail + logbook
 *   GET  /api/v1/activity             recent finds/hides/DNFs
 *   GET  /api/v1/leaderboard?metric=  top finders
 *   GET  /api/v1/corroborators        top IGates by Tier-A finds they helped verify
 *   GET  /api/v1/profile/:call        a callsign's public profile
 *   GET  /api/v1/stations?bbox=       live stations
 *   GET  /api/v1/spots?bbox=          live activity spots
 *   GET  /api/v1/licence/:call        callsign validity from imported public licence registers
 *
 * Runtime-neutral; CORS is applied globally (open for embeds).
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { setting } from "./siteconfig.js";
import { clientIp, rateLimitedDurable } from "./corroborate_privacy.js";
import { lookupApiKey, describeApiKey } from "./apikeys.js";
import { handleCachesInBBox, handleCacheDetail } from "./caches.js";
import { handleLeaderboard, handleActivity, handleProfile, handleCorroborators } from "./community.js";
import { handleStations, handleStation } from "./shack.js";
import { handleSpots } from "./spots.js";
import { licenceAnswer } from "./licence.js";
import {
  handleCachesGpx,
  handleCachesKml,
  handleCacheGpx,
  handleFindsAdif,
  handleStationTrack,
  handleStationKml,
} from "./exports.js";

const windowSec = (env: Env) => Number(setting(env, "API_RATE_WINDOW_SEC")) || 60;
const anonMax = (env: Env) => Number(setting(env, "API_RATE_ANON")) || 60;
const keyedMax = (env: Env) => Number(setting(env, "API_RATE_KEYED")) || 600;
/** Largest bounding-box side, in degrees, a read may ask for. */
const MAX_BBOX_DEG = 20;

const ENDPOINTS = [
  { method: "GET", path: "/api/v1/caches?bbox=minLon,minLat,maxLon,maxLat", desc: "caches in a bbox (capped)" },
  { method: "GET", path: "/api/v1/caches/:code", desc: "cache detail + logbook" },
  { method: "GET", path: "/api/v1/caches.gpx?bbox=", desc: "caches as GPX (GPS devices)" },
  { method: "GET", path: "/api/v1/caches.kml?bbox=", desc: "caches as KML (Google Earth)" },
  { method: "GET", path: "/api/v1/caches/:code.gpx", desc: "single cache as GPX" },
  { method: "GET", path: "/api/v1/profile/:call.adif", desc: "a callsign's finds as ADIF (logbooks)" },
  {
    method: "GET",
    path: "/api/v1/stats",
    desc: "the instance in three numbers: caches, finds heard on the air this week, stations heard in the last hour",
  },
  { method: "GET", path: "/api/v1/activity", desc: "recent finds, hides and DNFs" },
  { method: "GET", path: "/api/v1/leaderboard?metric=finds|points", desc: "top finders" },
  { method: "GET", path: "/api/v1/corroborators?bbox=&period=", desc: "top IGates by Tier-A finds they helped verify" },
  { method: "GET", path: "/api/v1/profile/:call", desc: "a callsign's public profile" },
  { method: "GET", path: "/api/v1/stations?bbox=", desc: "live APRS stations" },
  { method: "GET", path: "/api/v1/station/:call", desc: "one station's latest info" },
  { method: "GET", path: "/api/v1/station/:call/track?from=&to=", desc: "position history (JSON)" },
  { method: "GET", path: "/api/v1/station/:call.kml", desc: "position history as a KML track" },
  { method: "GET", path: "/api/v1/spots?bbox=", desc: "live activity spots" },
  { method: "GET", path: "/api/v1/licence/:call", desc: "callsign validity from public licence registers" },
  { method: "GET", path: "/api/v1/key", desc: "the API key this request presents" },
];

/** Pull an API key from Authorization: Bearer / x-api-key / ?key=. */
function extractKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim() || null;
  return req.headers.get("x-api-key") || new URL(req.url).searchParams.get("key") || null;
}

/** Rate-limit gate: resolves the tier (keyed if a valid key is presented) and 429s when over budget. */
export async function readGate(
  req: Request,
  env: Env,
): Promise<{ tier: "anon" | "keyed"; key: string | null } | Response> {
  const raw = extractKey(req);
  let key: string | null = null;
  let tier: "anon" | "keyed" = "anon";
  let max = anonMax(env);
  if (raw) {
    const row = await lookupApiKey(env, raw);
    if (row) {
      key = String(row.id);
      tier = "keyed";
      max = keyedMax(env);
    }
  }
  const bucket = key ? `apikey:${key}` : `apiip:${clientIp(req, env)}`;
  if (await rateLimitedDurable(env, bucket, Date.now(), max, windowSec(env) * 1000)) {
    return json(
      { error: "rate limit exceeded", tier, limit: max, windowSec: windowSec(env) },
      { status: 429, headers: { "retry-after": String(windowSec(env)), "x-ratelimit-limit": String(max) } },
    );
  }
  return { tier, key };
}

function apiIndex(env: Env): Response {
  return json({
    protocol: "aprscaching-readapi/1",
    version: "v1",
    access: "read-only · free",
    rateLimits: { window_seconds: windowSec(env), anonymous: anonMax(env), with_key: keyedMax(env) },
    keys: "Signed in, create a free key under Settings → Developer; send it as Authorization: Bearer <key> or ?key=.",
    pagination:
      "Linear lists (activity) accept ?limit= & ?cursor=; responses carry nextCursor + hasMore. Pass nextCursor back as ?cursor= for the next page (keyset, not offset).",
    bbox_max_degrees: MAX_BBOX_DEG,
    endpoints: ENDPOINTS,
  });
}

/** GET /api/v1/key — the presented key's own record: a script checks its key without the app. */
async function keyInfo(req: Request, env: Env): Promise<Response> {
  const raw = extractKey(req);
  const row = raw ? await describeApiKey(env, raw) : null;
  if (!row) return json({ error: "present a valid key as Authorization: Bearer <key>" }, { status: 401 });
  return json({ ...row, tier: "free" });
}

/** Reject a bbox larger than the cap (cost control); returns null if OK or absent. */
function bboxTooLarge(req: Request): Response | null {
  const raw = new URL(req.url).searchParams.get("bbox");
  if (!raw) return null;
  const p = raw.split(",").map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite))
    return json({ error: "bbox must be minLon,minLat,maxLon,maxLat" }, { status: 400 });
  if (Math.abs(p[2]! - p[0]!) > MAX_BBOX_DEG || Math.abs(p[3]! - p[1]!) > MAX_BBOX_DEG)
    return json({ error: `bbox too large (max ${MAX_BBOX_DEG}° per side)` }, { status: 400 });
  return null;
}

/** Dispatch /api/v1/* . `rest` is the path after /api/v1 (e.g. "", "/caches", "/caches/AC-0001"). */
export async function handleApiV1(req: Request, env: Env, rest: string): Promise<Response> {
  const m = req.method;
  if (rest === "" || rest === "/")
    return m === "GET" ? apiIndex(env) : json({ error: "method not allowed" }, { status: 405 });
  if (rest === "/keys" && m === "POST")
    return json(
      { error: "keys belong to an account: sign in and create one under Settings → Developer" },
      { status: 410 },
    );

  if (m !== "GET") return json({ error: "read-only API" }, { status: 405 });
  const g = await readGate(req, env);
  if (g instanceof Response) return g;
  if (rest === "/key") return keyInfo(req, env);

  // exports — GPX / KML / ADIF
  if (rest === "/caches.gpx") return bboxTooLarge(req) ?? handleCachesGpx(req, env);
  if (rest === "/caches.kml") return bboxTooLarge(req) ?? handleCachesKml(req, env);
  const gpxCode = /^\/caches\/([A-Za-z0-9-]+)\.gpx$/.exec(rest);
  if (gpxCode) return handleCacheGpx(req, env, gpxCode[1]!.toUpperCase());
  const adifCall = /^\/profile\/([A-Za-z0-9-]+)\.adif$/.exec(rest);
  if (adifCall) return handleFindsAdif(req, env, adifCall[1]!.toUpperCase());

  if (rest === "/caches") return bboxTooLarge(req) ?? handleCachesInBBox(req, env);
  const codeM = /^\/caches\/([A-Za-z0-9-]+)$/.exec(rest);
  if (codeM) {
    const row = await env.DB.prepare("SELECT id FROM caches WHERE code = ?")
      .bind(codeM[1]!.toUpperCase())
      .first<{ id: number }>();
    if (!row) return json({ error: "cache not found" }, { status: 404 });
    return handleCacheDetail(req, env, row.id);
  }
  if (rest === "/stats") return handleStats(env);
  if (rest === "/activity") return handleActivity(req, env);
  if (rest === "/leaderboard") return handleLeaderboard(req, env);
  if (rest === "/corroborators") return handleCorroborators(req, env);
  if (rest === "/stations") return bboxTooLarge(req) ?? handleStations(req, env);
  if (rest === "/spots") return bboxTooLarge(req) ?? handleSpots(req, env);
  const stTrack = /^\/station\/([A-Za-z0-9-]+)\/track$/.exec(rest);
  if (stTrack) return handleStationTrack(req, env, stTrack[1]!.toUpperCase());
  const stKml = /^\/station\/([A-Za-z0-9-]+)\.kml$/.exec(rest);
  if (stKml) return handleStationKml(req, env, stKml[1]!.toUpperCase());
  const stInfo = /^\/station\/([A-Za-z0-9-]+)$/.exec(rest);
  if (stInfo) return handleStation(req, env, stInfo[1]!.toUpperCase());
  const licM = /^\/licence\/([^/]+)$/.exec(rest);
  if (licM) return licenceAnswer(env, licM[1]!);
  const profM = /^\/profile\/([A-Za-z0-9-]+)$/.exec(rest);
  if (profM) return handleProfile(req, env, profM[1]!.toUpperCase());

  return json({ error: "not found", see: "/api/v1" }, { status: 404 });
}

/**
 * GET /api/v1/stats — the instance in three numbers, for the landing page and anyone's dashboard: active caches
 * hidden here, finds heard on the air (Tier A) in the last seven days, and stations heard in the last hour. Three
 * counts, cached for five minutes at the edge and in browsers; never estimated.
 */
async function handleStats(env: Env): Promise<Response> {
  const now = nowS();
  const [caches, onAir, stations] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM caches WHERE status = 'active' AND source = 'native'").first<{
      n: number;
    }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cache_logs WHERE log_type = 'found' AND verified = 1 AND tier = 'A' AND ts >= ?",
    )
      .bind(now - 7 * 86400)
      .first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM stations WHERE last_seen >= ?")
      .bind(now - 3600)
      .first<{ n: number }>(),
  ]);
  return json(
    {
      caches: caches?.n ?? 0,
      findsOnAirThisWeek: onAir?.n ?? 0,
      stationsHeardLastHour: stations?.n ?? 0,
      at: now,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
