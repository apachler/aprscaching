// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { initialBearing, destinationPoint, haversineMeters, toMgrs } from "../src/index.js";

describe("geo — bearing + destination", () => {
  it("bearing due north / east", () => {
    expect(initialBearing(0, 0, 1, 0)).toBeCloseTo(0, 1);
    expect(initialBearing(0, 0, 0, 1)).toBeCloseTo(90, 1);
  });

  it("destinationPoint round-trips with haversine + bearing", () => {
    const d = destinationPoint(47.07, 15.42, 90, 1000); // 1 km due east
    expect(haversineMeters(47.07, 15.42, d.lat, d.lon)).toBeCloseTo(1000, -1); // ~1 km
    expect(initialBearing(47.07, 15.42, d.lat, d.lon)).toBeCloseTo(90, 0);
    expect(d.lat).toBeCloseTo(47.07, 3); // due east ⇒ latitude ~unchanged
  });

  it("a ring of destination points is all radius away from centre", () => {
    for (const brg of [0, 45, 120, 270]) {
      const p = destinationPoint(48, 11, brg, 500);
      expect(haversineMeters(48, 11, p.lat, p.lon)).toBeCloseTo(500, 0);
    }
  });
});

describe("mgrs — lat/lon → MGRS", () => {
  it("the canonical (0,0) reference is 31N AA 66021 00000", () => {
    expect(toMgrs(0, 0)).toBe("31N AA 66021 00000");
  });

  it("New York City is in grid 18T WL", () => {
    expect(toMgrs(40.7128, -74.006).startsWith("18T WL ")).toBe(true);
  });

  it("honours a southern-hemisphere point + precision digits", () => {
    const m = toMgrs(-33.8688, 151.2093, 3); // Sydney
    expect(m.startsWith("56H ")).toBe(true);
    expect(m.split(" ")[3]).toHaveLength(3); // 3-digit (100 m) precision
  });

  it("returns empty outside MGRS coverage", () => {
    expect(toMgrs(88, 10)).toBe("");
  });
});
