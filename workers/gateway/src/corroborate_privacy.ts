// SPDX-License-Identifier: AGPL-3.0-or-later
import { secretOk } from "./auth.js";
/**
 * corroborate_privacy.ts — hardening + privacy coarsening for cross-instance corroboration.
 *
 * The corroboration endpoint must NOT become a precise "where was <callsign> at time T" oracle
 *. Two defenses, both pure + unit-tested:
 *   • the ASKER coarsens its query — snaps the center to a grid square and buckets the time window,
 *     so peers (and any middlebox) never receive exact lat/lon/second. The search radius is widened
 *     by the grid's half-diagonal so snapping can never miss a real hit (proof: a real point within
 *     the original radius R of the true center is ≤ R + halfDiagonal from the snapped center).
 *   • the ANSWERER coarsens its response UNCONDITIONALLY — a coarse distance bucket + a bucketed ts +
 *     the corroborating instance, never the exact IGate (unless the operator opts in via FED_REVEAL_IGATE).
 *     Unconditional means even a prober sending exact coordinates gets only a coarse answer.
 *
 * Plus best-effort abuse limits (also here): an optional shared-secret allowlist, an in-memory
 * fixed-window rate limiter (per-IP + per-callsign), and negative-result memoization. The in-memory
 * stores are per-isolate (so weaker on Workers' fan-out) but zero-cost and a meaningful first defense;
 * the shared secret + coarse responses are the load-bearing guarantees.
 */
import type { Env } from "./env.js";

const M_PER_DEG = 111_320; // metres per degree of latitude (good enough for slack sizing)

export interface CoarsenConfig {
  gridDeg: number; // grid-square size in degrees for the request center snap
  timeBucketSec: number; // time-window + response-ts bucket
  distBucketM: number; // response distance bucket
}
/** Site defaults: ~550 m grid, 10-min buckets, 100 m distance steps. Tunable per deployment. */
export const DEFAULT_COARSEN: CoarsenConfig = { gridDeg: 0.005, timeBucketSec: 600, distBucketM: 100 };

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Snap a coordinate to the centroid of its grid cell (no exact lat/lon on the wire). */
export function snapToGrid(lat: number, lon: number, cellDeg: number): { lat: number; lon: number } {
  if (!(cellDeg > 0)) return { lat, lon };
  const snap = (v: number) => (Math.floor(v / cellDeg) + 0.5) * cellDeg;
  return { lat: round6(snap(lat)), lon: round6(snap(lon)) };
}

/** Half-diagonal of a grid cell in metres — widen a search radius by this so snapping never misses. */
export function gridSlackM(cellDeg: number): number {
  if (!(cellDeg > 0)) return 0;
  return Math.ceil((cellDeg / 2) * Math.SQRT2 * M_PER_DEG);
}

/** Widen [since,until] out to bucket boundaries (defeats exact-second probing). */
export function bucketWindow(since: number, until: number, bucketSec: number): { since: number; until: number } {
  if (!(bucketSec > 0)) return { since, until };
  return { since: Math.floor(since / bucketSec) * bucketSec, until: Math.ceil(until / bucketSec) * bucketSec };
}

/** Round a distance UP to the next bucket (coarse "how near", not exact metres). */
export function distanceBucketM(m: number, bucketM: number): number {
  if (!(bucketM > 0)) return Math.round(m);
  return Math.ceil(m / bucketM) * bucketM;
}

/** Snap a timestamp DOWN to its bucket (coarse "roughly when", not the exact second). */
export function bucketTs(ts: number, bucketSec: number): number {
  if (!(bucketSec > 0)) return ts;
  return Math.floor(ts / bucketSec) * bucketSec;
}

// ---- abuse limits (in-memory, per-isolate, best-effort) ----
interface RlWindow {
  count: number;
  resetAt: number;
}
const rlBuckets = new Map<string, RlWindow>();
export const RL_MAX = 60; // probes per key per window
export const RL_WINDOW_MS = 60_000;

/** Fixed-window rate limit. Returns true when `key` is OVER budget. `nowMs` is injected for testing. */
export function rateLimited(key: string, nowMs: number, max = RL_MAX, windowMs = RL_WINDOW_MS): boolean {
  const w = rlBuckets.get(key);
  if (!w || nowMs >= w.resetAt) {
    // sweep expired windows once the map grows — long-lived Node/Bun processes
    // otherwise accumulate one entry per key forever.
    if (rlBuckets.size > 5000) for (const [k, v] of rlBuckets) if (nowMs >= v.resetAt) rlBuckets.delete(k);
    rlBuckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return false;
  }
  w.count++;
  return w.count > max;
}

/**
 * The DURABLE fixed-window limiter — one D1/SQLite row per key, incremented and rolled
 * over in a single upsert, so the budget survives isolate fan-out (Workers) and process restarts
 * (Node/Bun) alike. Used by every abuse-facing gate (read API, corroboration, key issuance,
 * signed ingest, passkey begin). Falls back to the in-memory limiter if the DB write fails —
 * degraded protection beats an outage that 500s every read.
 */
export async function rateLimitedDurable(
  env: Env,
  key: string,
  nowMs: number,
  max = RL_MAX,
  windowMs = RL_WINDOW_MS,
): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count    = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
       RETURNING count`,
    )
      .bind(key, nowMs + windowMs, nowMs, nowMs, nowMs + windowMs)
      .first<{ count: number }>();
    if (row?.count != null) return row.count > max;
  } catch {
    /* fall through to the in-memory limiter */
  }
  return rateLimited(key, nowMs, max, windowMs);
}

const negMemo = new Map<string, number>(); // key -> expiry (ms)
export const NEG_TTL_MS = 30_000;
const NEG_MAX_ENTRIES = 5000;

export function negCached(key: string, nowMs: number): boolean {
  const exp = negMemo.get(key);
  if (exp == null) return false;
  if (nowMs >= exp) {
    negMemo.delete(key);
    return false;
  }
  return true;
}
export function negStore(key: string, nowMs: number, ttlMs = NEG_TTL_MS): void {
  if (negMemo.size > NEG_MAX_ENTRIES) negMemo.clear(); // crude bound; correctness-neutral
  negMemo.set(key, nowMs + ttlMs);
}

/** Allowlist: open by default (small network); if FED_CORROBORATION_SECRET is set, require it. */
export function corroborationAuthorized(env: Env, req: Request): boolean {
  const secret = env.FED_CORROBORATION_SECRET;
  if (!secret) return true;
  return secretOk(req.headers.get("x-fed-secret"), secret);
}

/**
 * Client ip for rate-limit keying, from sources the CLIENT cannot choose.
 *  - cf-connecting-ip: stamped by Cloudflare's edge (never client-forwarded).
 *  - x-forwarded-for: honored ONLY when the operator declares a reverse proxy (TRUST_PROXY=1,
 *    topology 2/3 behind Caddy/CF) — otherwise any direct client could rotate identities per request.
 *  - x-real-ip: OVERWRITTEN by our Node/Bun bridges with the socket address, so a client-supplied
 *    value never survives to this point on the self-host runtimes.
 */
export function clientIp(req: Request, env?: Env): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  if (env?.TRUST_PROXY === "1") {
    const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim();
    if (xff) return xff;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

export function coarsenConfig(env: Env): CoarsenConfig {
  const n = (v: string | undefined, d: number) => (v != null && Number(v) > 0 ? Number(v) : d);
  return {
    gridDeg: n(env.FED_CORROBORATION_GRID_DEG, DEFAULT_COARSEN.gridDeg),
    timeBucketSec: n(env.FED_CORROBORATION_TIME_BUCKET_SEC, DEFAULT_COARSEN.timeBucketSec),
    distBucketM: n(env.FED_CORROBORATION_DIST_BUCKET_M, DEFAULT_COARSEN.distBucketM),
  };
}
