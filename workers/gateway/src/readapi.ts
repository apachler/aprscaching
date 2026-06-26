/**
 * readapi.ts — the public read API (docs/11 §6, ADR-4a). A versioned, documented, read-only surface
 * under /api/v1 that reuses the existing read handlers behind a rate-limit gate. Free + per-IP
 * limited; a free api_key raises the limit (recognition model — keys are never paywalled). The app's
 * internal /api/* endpoints are untouched, so this can't regress the app.
 *
 *   GET  /api/v1                      index: endpoint catalogue + limits + how to get a key
 *   POST /api/v1/keys                 issue a free key (optional {label, ownerCall})
 *   GET  /api/v1/keys/:key            key info (tier, owner, created)
 *   GET  /api/v1/caches?bbox=         caches in a (capped) bbox
 *   GET  /api/v1/caches/:code         cache detail + logbook
 *   GET  /api/v1/activity             recent finds/hides/DNFs
 *   GET  /api/v1/leaderboard?metric=  top finders
 *   GET  /api/v1/profile/:call        a callsign's public profile
 *   GET  /api/v1/stations?bbox=       live stations
 *   GET  /api/v1/spots?bbox=          live activity spots
 *
 * Runtime-neutral; CORS is applied globally (open for embeds).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { clientIp, rateLimited } from "./corroborate_privacy.js";
import { handleCachesInBBox, handleCacheDetail } from "./caches.js";
import { handleLeaderboard, handleActivity, handleProfile } from "./community.js";
import { handleStations } from "./workbench.js";
import { handleSpots } from "./spots.js";

const windowSec = (env: Env) => Number(env.API_RATE_WINDOW_SEC) || 60;
const anonMax = (env: Env) => Number(env.API_RATE_ANON) || 60;
const keyedMax = (env: Env) => Number(env.API_RATE_KEYED) || 600;
const maxBboxDeg = (env: Env) => Number(env.API_MAX_BBOX_DEG) || 20;
const now = () => Math.floor(Date.now() / 1000);

const ENDPOINTS = [
  { method: "GET", path: "/api/v1/caches?bbox=minLon,minLat,maxLon,maxLat", desc: "caches in a bbox (capped)" },
  { method: "GET", path: "/api/v1/caches/:code", desc: "cache detail + logbook" },
  { method: "GET", path: "/api/v1/activity", desc: "recent finds, hides and DNFs" },
  { method: "GET", path: "/api/v1/leaderboard?metric=finds|points", desc: "top finders" },
  { method: "GET", path: "/api/v1/profile/:call", desc: "a callsign's public profile" },
  { method: "GET", path: "/api/v1/stations?bbox=", desc: "live APRS stations" },
  { method: "GET", path: "/api/v1/spots?bbox=", desc: "live activity spots" },
  { method: "POST", path: "/api/v1/keys", desc: "issue a free API key" },
];

/** Pull an API key from Authorization: Bearer / x-api-key / ?key=. */
function extractKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim() || null;
  return req.headers.get("x-api-key") || new URL(req.url).searchParams.get("key") || null;
}

/** Rate-limit gate: resolves the tier (keyed if a valid key is presented) and 429s when over budget. */
async function gate(req: Request, env: Env): Promise<{ tier: "anon" | "keyed"; key: string | null } | Response> {
  const raw = extractKey(req);
  let key: string | null = null;
  let tier: "anon" | "keyed" = "anon";
  let max = anonMax(env);
  if (raw) {
    const row = await env.DB.prepare("SELECT key FROM api_keys WHERE key = ?").bind(raw).first();
    if (row) {
      key = raw; tier = "keyed"; max = keyedMax(env);
      try { await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE key = ?").bind(now(), raw).run(); } catch { /* best-effort */ }
    }
  }
  const bucket = key ? `apikey:${key}` : `apiip:${clientIp(req)}`;
  if (rateLimited(bucket, Date.now(), max, windowSec(env) * 1000)) {
    return json({ error: "rate limit exceeded", tier, limit: max, windowSec: windowSec(env) },
      { status: 429, headers: { "retry-after": String(windowSec(env)), "x-ratelimit-limit": String(max) } });
  }
  return { tier, key };
}

function apiIndex(env: Env): Response {
  return json({
    protocol: "aprscaching-readapi/1", version: "v1", access: "read-only · free (ADR-4a)",
    rateLimits: { window_seconds: windowSec(env), anonymous: anonMax(env), with_key: keyedMax(env) },
    keys: "POST /api/v1/keys for a free key; send it as Authorization: Bearer <key> or ?key=.",
    bbox_max_degrees: maxBboxDeg(env),
    endpoints: ENDPOINTS,
  });
}

async function issueKey(req: Request, env: Env): Promise<Response> {
  // throttle issuance per IP so the free endpoint can't be farmed
  if (rateLimited(`apikeyissue:${clientIp(req)}`, Date.now(), 5, 60_000))
    return json({ error: "too many key requests; try again shortly" }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { label?: string; ownerCall?: string };
  const key = "acg_" + crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare("INSERT INTO api_keys (key, owner_call, label, rate_tier, created_at) VALUES (?,?,?, 'free', ?)")
    .bind(key, body.ownerCall?.toUpperCase() || null, body.label?.slice(0, 80) || null, now()).run();
  return json({ key, tier: "free", limits: { window_seconds: windowSec(env), with_key: keyedMax(env) },
    usage: "Send as 'Authorization: Bearer <key>' or '?key=<key>'. Free; raises your rate limit." }, { status: 201 });
}

async function keyInfo(env: Env, key: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT owner_call AS ownerCall, label, rate_tier AS tier, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE key = ?")
    .bind(key).first();
  if (!row) return json({ error: "unknown key" }, { status: 404 });
  return json(row);
}

/** Reject a bbox larger than the cap (cost control); returns null if OK or absent. */
function bboxTooLarge(req: Request, env: Env): Response | null {
  const raw = new URL(req.url).searchParams.get("bbox");
  if (!raw) return null;
  const p = raw.split(",").map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite)) return json({ error: "bbox must be minLon,minLat,maxLon,maxLat" }, { status: 400 });
  const cap = maxBboxDeg(env);
  if (Math.abs(p[2]! - p[0]!) > cap || Math.abs(p[3]! - p[1]!) > cap)
    return json({ error: `bbox too large (max ${cap}° per side)` }, { status: 400 });
  return null;
}

/** Dispatch /api/v1/* . `rest` is the path after /api/v1 (e.g. "", "/caches", "/caches/AC-0001"). */
export async function handleApiV1(req: Request, env: Env, rest: string): Promise<Response> {
  const m = req.method;
  if (rest === "" || rest === "/") return m === "GET" ? apiIndex(env) : json({ error: "method not allowed" }, { status: 405 });
  if (rest === "/keys" && m === "POST") return issueKey(req, env);
  const keyM = /^\/keys\/([A-Za-z0-9_]+)$/.exec(rest);
  if (keyM && m === "GET") return keyInfo(env, keyM[1]!);

  if (m !== "GET") return json({ error: "read-only API" }, { status: 405 });
  const g = await gate(req, env);
  if (g instanceof Response) return g;

  if (rest === "/caches") return bboxTooLarge(req, env) ?? handleCachesInBBox(req, env);
  const codeM = /^\/caches\/([A-Za-z0-9-]+)$/.exec(rest);
  if (codeM) {
    const row = await env.DB.prepare("SELECT id FROM caches WHERE code = ?").bind(codeM[1]!.toUpperCase()).first<{ id: number }>();
    if (!row) return json({ error: "cache not found" }, { status: 404 });
    return handleCacheDetail(req, env, row.id);
  }
  if (rest === "/activity") return handleActivity(req, env);
  if (rest === "/leaderboard") return handleLeaderboard(req, env);
  if (rest === "/stations") return bboxTooLarge(req, env) ?? handleStations(req, env);
  if (rest === "/spots") return bboxTooLarge(req, env) ?? handleSpots(req, env);
  const profM = /^\/profile\/([A-Za-z0-9-]+)$/.exec(rest);
  if (profM) return handleProfile(req, env, profM[1]!.toUpperCase());

  return json({ error: "not found", see: "/api/v1" }, { status: 404 });
}
