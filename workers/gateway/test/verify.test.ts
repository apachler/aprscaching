// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  verifyFind, DEFAULT_POLICY,
  type CacheRow, type PositionRow, type AppGeo, type VerifyPolicy,
} from "../src/verify.js";

// Reference cache near Graz, OE.
const CACHE: CacheRow = { id: 1, code: "AC-0001", type: "single", lat: 47.07, lon: 15.42, min_trust: null };

// ~111 m north of the cache (inside the 150 m radius); ~111 km north is well outside.
const NEAR = { lat: 47.071, lon: 15.42 };
const FAR = { lat: 48.07, lon: 15.42 };

function pos(p: Partial<PositionRow> & Pick<PositionRow, "lat" | "lon" | "heard_via">): PositionRow {
  const merged = { id: 10, callsign: "OE8APR-9", ts: 1000, igate_call: null, ...p };
  // Mirror the boundary's provenance stamp (provenance.ts): an RF fix with a gating site is
  // first-party attested. Explicit firstPartyAttested on the input still wins.
  return { firstPartyAttested: merged.heard_via === "rf" && !!merged.igate_call, ...merged };
}

describe("verifyFind — tier A (RF, independently gated)", () => {
  it("verifies a RF-heard fix gated by an independent IGate within radius", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8XXX", id: 42 })],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    expect(r).toMatchObject({ verified: true, tier: "A", method: "aprs_rf", matchedPositionId: 42 });
    expect(r.distanceM!).toBeLessThan(150);
  });

  it("does NOT grant tier A when the fix was self-gated (own IGate)", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8APR" })],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    // self-gated rf can't corroborate -> drops to IS-only (C), which fails the default min tier B
    expect(r.tier).toBe("C");
    expect(r.verified).toBe(false);
  });

  // SR-TRUST-01: self-gating is judged by BASE call — running your IGate under another SSID
  // (OE8APR-9 beacon gated by OE8APR-10) is still self-gating and must never mint Tier A.
  it("does NOT grant tier A when the fix was gated by another SSID of the logger's own call", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8APR-10" })],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    expect(r.tier).toBe("C");
    expect(r.verified).toBe(false);
  });

  it("does NOT grant tier A when the gater is a station the logger registered", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8ZZZ-1" })],
      loggerOwnIgates: new Set(["OE8APR", "OE8ZZZ"]),   // OE8ZZZ = the logger's account_stations entry
    });
    expect(r.tier).toBe("C");
    expect(r.verified).toBe(false);
  });

  it("does NOT grant tier A when there is no gating IGate at all", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: null })],
    });
    expect(r.tier).toBe("C");
    expect(r.verified).toBe(false);
  });

  it("no match when the RF fix is outside the radius", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...FAR, heard_via: "rf", igate_call: "OE8XXX" })],
    });
    expect(r).toMatchObject({ verified: false, tier: "C", method: "none" });
  });
});

// SR-TRUST-02: a Tier-A match must be reachable from the logger's own neighbouring fixes at a sane
// speed — a single forged beacon dropped at the cache while the real track is 111 km away is a teleport.
describe("verifyFind — tier A plausible track (SR-TRUST-02)", () => {
  it("rejects a matched fix a neighbouring fix cannot reach in the elapsed time (teleport)", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [
        pos({ ...NEAR, heard_via: "rf", igate_call: "OE8XXX", ts: 1000, id: 42 }), // 'at' the cache
        pos({ ...FAR,  heard_via: "rf", igate_call: "OE8YYY", ts: 1000, id: 43 }), // 111 km away, same instant
      ],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    expect(r.tier).not.toBe("A");
    expect(r.verified).toBe(false);
  });

  it("still grants tier A for a consistent track (two nearby fixes 60 s apart)", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [
        pos({ ...NEAR, heard_via: "rf", igate_call: "OE8XXX", ts: 1060, id: 42 }),
        pos({ lat: 47.0705, lon: 15.42, heard_via: "rf", igate_call: "OE8XXX", ts: 1000, id: 43 }),
      ],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    expect(r).toMatchObject({ verified: true, tier: "A" });
  });

  it("grants tier A on a lone fix (no neighbour to contradict — benign single beacon)", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8XXX", id: 42 })],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    expect(r).toMatchObject({ verified: true, tier: "A" });
  });
});

describe("verifyFind — tier B (first-party app geolocation)", () => {
  it("verifies an in-app reading near the cache", () => {
    const appGeo: AppGeo = { ...NEAR, accuracyM: 20, ts: 1000 };
    const r = verifyFind(CACHE, appGeo, { loggerPositions: [] });
    expect(r).toMatchObject({ verified: true, tier: "B", method: "app_geo" });
  });

  // SR-TRUST-03: when the request time is known, a stale/fabricated app reading must not reach B.
  it("rejects a stale app reading when log time is known", () => {
    const nowT = 1_800_000_000;
    const stale: AppGeo = { ...NEAR, accuracyM: 20, ts: nowT - 86_400 };  // a day old
    const r = verifyFind(CACHE, stale, { loggerPositions: [], now: nowT });
    expect(r.tier).not.toBe("B");
    expect(r.verified).toBe(false);
  });

  it("accepts a contemporaneous app reading when log time is known", () => {
    const nowT = 1_800_000_000;
    const fresh: AppGeo = { ...NEAR, accuracyM: 20, ts: nowT - 5 };
    const r = verifyFind(CACHE, fresh, { loggerPositions: [], now: nowT });
    expect(r).toMatchObject({ verified: true, tier: "B" });
  });

  it("clamps a bogus (negative/NaN) accuracy instead of trusting it", () => {
    const nowT = 1_800_000_000;
    const bogus: AppGeo = { ...FAR, accuracyM: -1e9, ts: nowT };  // attacker tries a huge negative
    const r = verifyFind(CACHE, bogus, { loggerPositions: [], now: nowT });
    expect(r.verified).toBe(false);   // FAR is 111 km away; a bogus accuracy can't stretch tolerance
  });

  it("a poor-accuracy reading is tolerated up to the accuracy cap", () => {
    const appGeo: AppGeo = { lat: 47.0715, lon: 15.42, accuracyM: 150, ts: 1000 };
    const r = verifyFind(CACHE, appGeo, { loggerPositions: [] });
    expect(r.verified).toBe(true);
    expect(r.tier).toBe("B");
  });

  it("an app reading far from the cache does not verify", () => {
    const appGeo: AppGeo = { ...FAR, accuracyM: 10, ts: 1000 };
    const r = verifyFind(CACHE, appGeo, { loggerPositions: [] });
    expect(r.verified).toBe(false);
  });
});

describe("verifyFind — tier C (IS-only) and policy", () => {
  it("records tier C for a bare APRS-IS beacon near the cache, unverified under default policy", () => {
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "aprs_is" })],
    });
    expect(r.tier).toBe("C");
    expect(r.verified).toBe(false);          // default minTier is B
    expect(r.method).toBe("aprs_is");
  });

  it("a lenient site policy (minTier C) accepts the IS-only beacon", () => {
    const lenient: VerifyPolicy = { ...DEFAULT_POLICY, minTier: "C" };
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "aprs_is" })],
    }, lenient);
    expect(r).toMatchObject({ verified: true, tier: "C" });
  });
});

describe("verifyFind — provenance seam: transport ≠ trust", () => {
  it("an RF-ish fix that is NOT first-party attested stays tier C even within radius", () => {
    // e.g. an AXIP/HAMNET-tunnelled frame: looks 'rf' but no site we attest → no Tier-A uplift.
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8XXX", firstPartyAttested: false })],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    expect(r.tier).toBe("C");
    expect(r.verified).toBe(false);
  });

  it("grants tier A on the attestation flag alone, independent of the transport label", () => {
    // The flag is what counts; the heard_via label here is deliberately not 'rf'.
    const r = verifyFind(CACHE, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "aprs_is", igate_call: "OE8XXX", firstPartyAttested: true, id: 99 })],
      loggerOwnIgates: new Set(["OE8APR"]),
    });
    expect(r).toMatchObject({ verified: true, tier: "A", method: "aprs_rf", matchedPositionId: 99 });
  });
});

describe("verifyFind — per-cache min_trust override", () => {
  it("a tier-B app match fails a cache that demands tier A", () => {
    const strict: CacheRow = { ...CACHE, min_trust: "A" };
    const appGeo: AppGeo = { ...NEAR, accuracyM: 10, ts: 1000 };
    const r = verifyFind(strict, appGeo, { loggerPositions: [] });
    expect(r.tier).toBe("B");
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/tier A/);
  });
});

describe("verifyFind — living (moving) cache", () => {
  const living: CacheRow = { id: 2, code: "AC-0002", type: "aprs_living", lat: null, lon: null, station_call: "OE8XYZ-9" };

  it("verifies co-location with the cache-station within the time skew", () => {
    const r = verifyFind(living, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8XXX", ts: 1000, id: 7 })],
      cacheStationPositions: [pos({ lat: 47.0711, lon: 15.42, heard_via: "rf", ts: 1100 })],
    });
    expect(r).toMatchObject({ verified: true, tier: "A", method: "aprs_rf", matchedPositionId: 7 });
  });

  it("does not verify when the cache-station fix is outside the skew window", () => {
    const r = verifyFind(living, undefined, {
      loggerPositions: [pos({ ...NEAR, heard_via: "rf", igate_call: "OE8XXX", ts: 1000 })],
      cacheStationPositions: [pos({ ...NEAR, heard_via: "rf", ts: 1000 + 10 * 60 })], // 10 min skew > 5
    });
    expect(r.verified).toBe(false);
  });
});
