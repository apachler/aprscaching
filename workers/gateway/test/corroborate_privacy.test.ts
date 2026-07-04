// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  snapToGrid,
  gridSlackM,
  bucketWindow,
  distanceBucketM,
  bucketTs,
  rateLimited,
  negCached,
  negStore,
  corroborationAuthorized,
  clientIp,
} from "../src/corroborate_privacy.js";
import { haversineMeters } from "@aprsweb/aprs";
import type { Env } from "../src/env.js";

describe("corroboration privacy coarsening", () => {
  it("snapToGrid lands on the cell centroid and is idempotent", () => {
    const a = snapToGrid(47.2003, 15.0501, 0.005);
    const b = snapToGrid(a.lat, a.lon, 0.005);
    expect(a).toEqual(b); // snapping a snapped point is stable
    expect(a.lat).not.toBe(47.2003); // exact coordinate does not survive
    expect((a.lat / 0.005) % 1).toBeCloseTo(0.5, 6); // centroid = (n + 0.5)*cell
  });

  it("snapToGrid is a no-op for a non-positive cell", () => {
    expect(snapToGrid(47.2, 15.05, 0)).toEqual({ lat: 47.2, lon: 15.05 });
  });

  it("widening a radius by gridSlackM guarantees a snapped center never misses a real hit", () => {
    const cell = 0.005,
      slack = gridSlackM(cell);
    // worst case: true center at a cell corner, real hit 150 m away on the far side
    const trueLat = 47.0,
      trueLon = 15.0; // exactly on a grid line (corner-ish)
    const snapped = snapToGrid(trueLat, trueLon, cell);
    const displacement = haversineMeters(trueLat, trueLon, snapped.lat, snapped.lon);
    expect(displacement).toBeLessThanOrEqual(slack); // snap error is covered by the slack
    expect(slack).toBe(394); // ceil(0.0025*√2*111320)
  });

  it("bucketWindow only ever widens the window to bucket edges", () => {
    const { since, until } = bucketWindow(1000, 1001, 600);
    expect(since).toBe(600);
    expect(until).toBe(1200);
    expect(since).toBeLessThanOrEqual(1000);
    expect(until).toBeGreaterThanOrEqual(1001);
  });

  it("distanceBucketM rounds UP (coarse 'how near'), never leaking exact metres", () => {
    expect(distanceBucketM(0, 100)).toBe(0);
    expect(distanceBucketM(55, 100)).toBe(100);
    expect(distanceBucketM(100, 100)).toBe(100);
    expect(distanceBucketM(101, 100)).toBe(200);
  });

  it("bucketTs floors to the bucket (coarse 'roughly when')", () => {
    expect(bucketTs(1799, 600)).toBe(1200);
    expect(bucketTs(1200, 600)).toBe(1200);
  });
});

describe("corroboration abuse limits", () => {
  it("rateLimited trips once a key exceeds its budget, and resets after the window", () => {
    const key = "ip:test-A",
      t0 = 1_000_000;
    for (let i = 0; i < 60; i++) expect(rateLimited(key, t0, 60, 60_000)).toBe(false); // 60 allowed
    expect(rateLimited(key, t0, 60, 60_000)).toBe(true); // 61st over budget
    expect(rateLimited(key, t0 + 60_000, 60, 60_000)).toBe(false); // new window resets
  });

  it("negative memoization caches within the TTL and expires after it", () => {
    const key = "neg:test-B",
      t0 = 2_000_000;
    expect(negCached(key, t0)).toBe(false);
    negStore(key, t0, 30_000);
    expect(negCached(key, t0 + 29_999)).toBe(true);
    expect(negCached(key, t0 + 30_000)).toBe(false); // expired
  });

  it("corroborationAuthorized is open without a secret, gated with one", () => {
    const open = {} as Env;
    expect(corroborationAuthorized(open, new Request("http://x"))).toBe(true);
    const gated = { FED_CORROBORATION_SECRET: "s3cret" } as Env;
    expect(corroborationAuthorized(gated, new Request("http://x"))).toBe(false);
    expect(corroborationAuthorized(gated, new Request("http://x", { headers: { "x-fed-secret": "nope" } }))).toBe(
      false,
    );
    expect(corroborationAuthorized(gated, new Request("http://x", { headers: { "x-fed-secret": "s3cret" } }))).toBe(
      true,
    );
  });

  it("clientIp trusts only unforgeable sources", () => {
    expect(clientIp(new Request("http://x", { headers: { "cf-connecting-ip": "1.2.3.4" } }))).toBe("1.2.3.4");
    // a client-supplied XFF is IGNORED unless the operator declares a reverse proxy
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "5.6.7.8, 9.9.9.9" } }))).toBe("unknown");
    expect(
      clientIp(new Request("http://x", { headers: { "x-forwarded-for": "5.6.7.8, 9.9.9.9" } }), {
        TRUST_PROXY: "1",
      } as never),
    ).toBe("5.6.7.8");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
