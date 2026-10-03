// SPDX-License-Identifier: AGPL-3.0-or-later
// The "you're near" check on the device: the nearest cache a player could log, within the radius, from a reading
// sure enough to tell.
import { describe, expect, it } from "vitest";
import { nearestLoggable } from "../src/caches/near.js";
import type { MapCache } from "../src/api.js";

const cache = (id: number | null, lat: number, over: Partial<MapCache> = {}) =>
  ({
    id,
    code: `AC-${id}`,
    title: `Cache ${id}`,
    lat,
    lon: 15,
    status: "active",
    ownerCall: "OE1XYZ",
    ...over,
  }) as MapCache;
const at = (lat: number, accuracyM = 10) => ({ lat, lon: 15, accuracyM });

describe("the near check on the device", () => {
  it("names the nearest loggable cache within 150 m", () => {
    const caches = [cache(1, 47.001), cache(2, 47.0005), cache(3, 47.01)];
    expect(nearestLoggable(caches, at(47), "OE8APR", new Set())).toMatchObject({ cacheId: 2, distanceM: 56 });
    expect(nearestLoggable([cache(3, 47.01)], at(47), "OE8APR", new Set())).toBeNull();
  });

  it("leaves out mirrors, inactive caches, the player's own and the ones already prompted", () => {
    const near = 47.0005;
    expect(nearestLoggable([cache(null, near)], at(47), "OE8APR", new Set())).toBeNull();
    expect(nearestLoggable([cache(1, near, { status: "disabled" })], at(47), "OE8APR", new Set())).toBeNull();
    expect(nearestLoggable([cache(1, near, { ownerCall: "OE8APR-7" })], at(47), "OE8APR", new Set())).toBeNull();
    expect(nearestLoggable([cache(1, near)], at(47), "OE8APR", new Set([1]))).toBeNull();
  });

  it("stays quiet on a reading too unsure to tell", () => {
    expect(nearestLoggable([cache(1, 47.0005)], at(47, 250), "OE8APR", new Set())).toBeNull();
  });
});
