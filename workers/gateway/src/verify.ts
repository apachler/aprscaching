/**
 * verify.ts — APRS Caching presence-verification engine.
 *
 * Trust tiers (trust follows corroboration, not transport):
 *   A  RF-corroborated : position heard on RF (qAR), gated by an IGate that is NOT
 *                        the logger's own, with a plausible track. Strongest.
 *   B  App-corroborated: a first-party device-Geolocation reading taken in-app at log
 *                        time matches the cache. This is the path for phone-app loggers
 *                        with no radio. A bare APRS-IS beacon CANNOT reach tier B on its
 *                        own — the corroboration must come from the independent app reading.
 *   C  IS-only         : a bare APRS-IS beacon, no RF gating, no app reading. Logged but
 *                        badged unverified.
 *
 * Site policy sets the minimum tier that counts as "verified". Caches may override
 * (e.g. flagship/competition caches require A).
 */

import { haversineMeters } from "@aprsweb/aprs";

export type TrustTier = "A" | "B" | "C";

export interface VerifyPolicy {
  minTier: TrustTier;          // site default; cache.min_trust overrides
  radiusM: number;             // base match radius (default 150)
  windowSec: number;           // how far back to look for a matching position
  livingSkewSec: number;       // max time skew when matching a moving cache-station
  requireIndependentIgate: boolean; // tier A demands a gater != logger's own IGate
}

export const DEFAULT_POLICY: VerifyPolicy = {
  minTier: "B",                // A or B verify; C is logged-but-unverified
  radiusM: 150,
  windowSec: 30 * 60,
  livingSkewSec: 5 * 60,
  requireIndependentIgate: true,
};

export interface PositionRow {
  id: number; callsign: string; ts: number; lat: number; lon: number;
  heard_via: "rf" | "aprs_is" | "app"; igate_call?: string | null;
}

export interface CacheRow {
  id: number; code: string; type: string;
  lat?: number | null; lon?: number | null;
  station_call?: string | null;     // for aprs_living
  min_trust?: TrustTier | null;     // per-cache override
}

export interface AppGeo { lat: number; lon: number; accuracyM: number; ts: number }

export interface VerifyResult {
  verified: boolean;
  tier: TrustTier;
  method: "aprs_rf" | "aprs_rf_peer" | "app_geo" | "aprs_is" | "none";
  matchedPositionId?: number;
  distanceM?: number;
  reason?: string;
}

/** Data the engine needs, supplied by the caller (Worker reads these from D1). */
export interface VerifyDeps {
  /** logger's stored positions within [now-window, now], newest first */
  loggerPositions: PositionRow[];
  /** for aprs_living: the cache-station's positions in the same window */
  cacheStationPositions?: PositionRow[];
  /** the logger's own IGate callsign(s), to enforce independence in tier A */
  loggerOwnIgates?: Set<string>;
}

function effectiveMinTier(cache: CacheRow, policy: VerifyPolicy): TrustTier {
  return cache.min_trust ?? policy.minTier;
}

function rank(t: TrustTier): number { return t === "A" ? 3 : t === "B" ? 2 : 1; }

/** Tier A: RF-heard, independently gated, near the target. */
function tryRf(cache: CacheRow, deps: VerifyDeps, policy: VerifyPolicy): VerifyResult | null {
  if (cache.lat == null || cache.lon == null) return null;
  for (const p of deps.loggerPositions) {
    if (p.heard_via !== "rf") continue;
    if (policy.requireIndependentIgate) {
      const ig = p.igate_call ?? "";
      if (!ig || deps.loggerOwnIgates?.has(ig)) continue; // self-gated => not corroborated
    }
    const d = haversineMeters(p.lat, p.lon, cache.lat, cache.lon);
    if (d <= policy.radiusM) {
      return { verified: true, tier: "A", method: "aprs_rf", matchedPositionId: p.id, distanceM: d };
    }
  }
  return null;
}

/** Tier A for living caches: logger co-located with the moving cache-station. */
function tryLiving(cache: CacheRow, deps: VerifyDeps, policy: VerifyPolicy): VerifyResult | null {
  const cs = deps.cacheStationPositions ?? [];
  if (!cs.length) return null;
  for (const p of deps.loggerPositions) {
    if (p.heard_via !== "rf") continue;
    // nearest cache-station fix in time
    let best: PositionRow | null = null, bestSkew = Infinity;
    for (const c of cs) {
      const skew = Math.abs(c.ts - p.ts);
      if (skew < bestSkew) { bestSkew = skew; best = c; }
    }
    if (!best || bestSkew > policy.livingSkewSec) continue;
    const d = haversineMeters(p.lat, p.lon, best.lat, best.lon);
    if (d <= policy.radiusM) {
      return { verified: true, tier: "A", method: "aprs_rf", matchedPositionId: p.id, distanceM: d };
    }
  }
  return null;
}

/** Tier B: first-party app geolocation at log time matches the cache. */
function tryApp(cache: CacheRow, appGeo: AppGeo | undefined, policy: VerifyPolicy): VerifyResult | null {
  if (!appGeo || cache.lat == null || cache.lon == null) return null;
  const d = haversineMeters(appGeo.lat, appGeo.lon, cache.lat, cache.lon);
  // require the reading to be near AND not absurdly imprecise
  const tolerance = policy.radiusM + Math.min(appGeo.accuracyM, 200);
  if (d <= tolerance) {
    return { verified: true, tier: "B", method: "app_geo", distanceM: d };
  }
  return null;
}

/**
 * Run verification. Returns the best tier achieved and whether it meets policy.
 * `verified` reflects policy.minTier; a result can be a real match (tier A/B) yet
 * `verified=false` if a stricter cache demanded a higher tier.
 */
export function verifyFind(
  cache: CacheRow,
  appGeo: AppGeo | undefined,
  deps: VerifyDeps,
  policy: VerifyPolicy = DEFAULT_POLICY,
): VerifyResult {
  const min = effectiveMinTier(cache, policy);

  // Try strongest first.
  const rf = cache.type === "aprs_living"
    ? tryLiving(cache, deps, policy)
    : tryRf(cache, deps, policy);
  const app = tryApp(cache, appGeo, policy);

  const best = rf ?? app ?? null;
  if (best) {
    const meets = rank(best.tier) >= rank(min);
    return { ...best, verified: meets, reason: meets ? undefined : `cache requires tier ${min}` };
  }

  // No corroboration. If we at least saw an IS beacon near the cache, record tier C.
  if (cache.lat != null && cache.lon != null) {
    for (const p of deps.loggerPositions) {
      const d = haversineMeters(p.lat, p.lon, cache.lat, cache.lon);
      if (d <= policy.radiusM) {
        return { verified: rank("C") >= rank(min), tier: "C", method: "aprs_is",
                 matchedPositionId: p.id, distanceM: d, reason: "IS-only, uncorroborated" };
      }
    }
  }
  return { verified: false, tier: "C", method: "none", reason: "no position near cache in window" };
}
