// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * verify.ts — APRScaching presence-verification engine.
 *
 * Trust tiers (trust follows corroboration, not transport):
 *   A  RF-corroborated : position heard at a first-party-attested receiving site
 *                        (provenance.firstPartyAttested — see provenance.ts), gated by
 *                        an IGate that is NOT the logger's own, with a plausible track.
 *                        Strongest. Gated on attestation ALONE, never on transport: a
 *                        packet that merely arrived over an RF-ish tunnel (AXIP/HAMNET)
 *                        without a site we attest stays Tier C.
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
  minTier: TrustTier; // site default; cache.min_trust overrides
  radiusM: number; // base match radius (default 150)
  windowSec: number; // how far back to look for a matching position
  livingSkewSec: number; // max time skew when matching a moving cache-station
  requireIndependentIgate: boolean; // tier A demands a gater != logger's own IGate
  maxSpeedKmh: number; // tier A "plausible track": reject a fix reached from a neighbour faster than this
  appMaxAgeSec: number; // tier B: reject an app reading whose timestamp is older/newer than this vs log time
}

export const DEFAULT_POLICY: VerifyPolicy = {
  minTier: "B", // A or B verify; C is logged-but-unverified
  radiusM: 150,
  windowSec: 30 * 60,
  livingSkewSec: 5 * 60,
  requireIndependentIgate: true,
  maxSpeedKmh: 300, // ~faster than any ground travel; a matched fix a track can't reach is a teleport
  appMaxAgeSec: 120, // the in-app reading must be roughly contemporaneous with the log
};

export interface PositionRow {
  id: number;
  callsign: string;
  ts: number;
  lat: number;
  lon: number;
  heard_via: "rf" | "aprs_is" | "app";
  igate_call?: string | null;
  /**
   * Provenance seam: set by the boundary (see provenance.ts) when this fix was heard at a
   * site we operate + attest. Tier A is gated on THIS flag alone — never on transport. A packet that
   * merely arrived over some RF-ish transport (AXIP/HAMNET tunnel) without attestation stays Tier C.
   */
  firstPartyAttested?: boolean;
}

export interface CacheRow {
  id: number;
  code: string;
  type: string;
  lat?: number | null;
  lon?: number | null;
  station_call?: string | null; // for aprs_living
  min_trust?: TrustTier | null; // per-cache override
}

export interface AppGeo {
  lat: number;
  lon: number;
  accuracyM: number;
  ts: number;
}

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
  /** BASE callsigns the logger controls (own call, held account calls, registered stations) —
   *  a fix gated by any of these can never corroborate the logger's own find */
  loggerOwnIgates?: Set<string>;
  /** request/log time (unix s) — Tier-B app-reading freshness is checked against this */
  now?: number;
}

function effectiveMinTier(cache: CacheRow, policy: VerifyPolicy): TrustTier {
  return cache.min_trust ?? policy.minTier;
}

function rank(t: TrustTier): number {
  return t === "A" ? 3 : t === "B" ? 2 : 1;
}

const igBase = (c: string): string => c.split("-")[0]!.toUpperCase();

/** True when this fix was gated by an IGate independent of the logger (compared by BASE call —
 *  OE8APR-10 gating OE8APR-9 is still self-gating). No gater or a controlled gater ⇒ not independent. */
function independentlyGated(p: PositionRow, deps: VerifyDeps): boolean {
  const ig = p.igate_call ?? "";
  return !!ig && !deps.loggerOwnIgates?.has(igBase(ig));
}

/**
 * "plausible track": a matched Tier-A fix must be reachable from the logger's own
 * neighbouring fixes at a sane ground speed. A single forged/replayed beacon dropped at the cache
 * while the real track is elsewhere implies an impossible speed → not a real presence. With no other
 * fix in the window there is nothing to contradict (benign single-beacon case) → allowed.
 */
function plausibleTrack(match: PositionRow, deps: VerifyDeps, policy: VerifyPolicy): boolean {
  const maxMps = (policy.maxSpeedKmh * 1000) / 3600;
  let nearest: PositionRow | null = null,
    bestDt = Infinity;
  for (const p of deps.loggerPositions) {
    if (p === match || p.id === match.id) continue;
    const dt = Math.abs(p.ts - match.ts);
    if (dt < bestDt) {
      bestDt = dt;
      nearest = p;
    }
  }
  if (!nearest) return true; // no track to contradict the fix
  const dt = Math.max(1, Math.abs(nearest.ts - match.ts)); // avoid /0; sub-second gaps clamp to 1 s
  const dist = haversineMeters(nearest.lat, nearest.lon, match.lat, match.lon);
  return dist / dt <= maxMps; // reachable at a plausible speed
}

/** Tier A: heard at a first-party-attested site, independently gated, near the target. */
function tryRf(cache: CacheRow, deps: VerifyDeps, policy: VerifyPolicy): VerifyResult | null {
  if (cache.lat == null || cache.lon == null) return null;
  for (const p of deps.loggerPositions) {
    if (!p.firstPartyAttested) continue; // transport-vs-trust seam: the ONLY Tier-A gate
    if (policy.requireIndependentIgate && !independentlyGated(p, deps)) continue; // self-gated => not corroborated
    const d = haversineMeters(p.lat, p.lon, cache.lat, cache.lon);
    if (d <= policy.radiusM && plausibleTrack(p, deps, policy)) {
      // near AND reachable
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
    if (!p.firstPartyAttested) continue; // Tier A demands an attested first-party fix
    if (policy.requireIndependentIgate && !independentlyGated(p, deps)) continue; // same rule as tryRf
    // nearest cache-station fix in time
    let best: PositionRow | null = null,
      bestSkew = Infinity;
    for (const c of cs) {
      const skew = Math.abs(c.ts - p.ts);
      if (skew < bestSkew) {
        bestSkew = skew;
        best = c;
      }
    }
    if (!best || bestSkew > policy.livingSkewSec) continue;
    const d = haversineMeters(p.lat, p.lon, best.lat, best.lon);
    if (d <= policy.radiusM && plausibleTrack(p, deps, policy)) {
      return { verified: true, tier: "A", method: "aprs_rf", matchedPositionId: p.id, distanceM: d };
    }
  }
  return null;
}

/** Tier B: first-party app geolocation at log time matches the cache. */
function tryApp(
  cache: CacheRow,
  appGeo: AppGeo | undefined,
  deps: VerifyDeps,
  policy: VerifyPolicy,
): VerifyResult | null {
  if (!appGeo || cache.lat == null || cache.lon == null) return null;
  // the reading must be contemporaneous with the log — an attacker-supplied `ts` that is
  // stale or fabricated (a days-old/replayed reading at the cache coords) must NOT reach Tier B. When
  // `now` is known (the request boundary passes it), require the reading within ±appMaxAgeSec.
  if (deps.now != null) {
    if (!Number.isFinite(appGeo.ts) || Math.abs(deps.now - appGeo.ts) > policy.appMaxAgeSec) return null;
  }
  const d = haversineMeters(appGeo.lat, appGeo.lon, cache.lat, cache.lon);
  // require the reading to be near AND not absurdly imprecise (clamp a bogus/negative accuracy)
  const acc = Number.isFinite(appGeo.accuracyM) ? Math.max(0, Math.min(appGeo.accuracyM, 200)) : 200;
  const tolerance = policy.radiusM + acc;
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
  const rf = cache.type === "aprs_living" ? tryLiving(cache, deps, policy) : tryRf(cache, deps, policy);
  const app = tryApp(cache, appGeo, deps, policy);

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
        return {
          verified: rank("C") >= rank(min),
          tier: "C",
          method: "aprs_is",
          matchedPositionId: p.id,
          distanceM: d,
          reason: "IS-only, uncorroborated",
        };
      }
    }
  }
  return { verified: false, tier: "C", method: "none", reason: "no position near cache in window" };
}
