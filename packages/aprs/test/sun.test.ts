// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { subsolarPoint, terminatorLatitude, greatCircleArc, haversineMeters } from "../src/index.js";

describe("sun — subsolar point (docs/design/11 terminator)", () => {
  it("subsolar latitude ≈ +23.44° at the June solstice", () => {
    const t = Date.UTC(2024, 5, 20, 20, 51, 0) / 1000; // 2024 June solstice
    expect(subsolarPoint(t).lat).toBeCloseTo(23.44, 0); // max northern declination
  });

  it("subsolar latitude ≈ −23.44° at the December solstice", () => {
    const t = Date.UTC(2024, 11, 21, 9, 21, 0) / 1000; // 2024 December solstice
    expect(subsolarPoint(t).lat).toBeCloseTo(-23.44, 0);
  });

  it("subsolar latitude ≈ 0° at an equinox", () => {
    const t = Date.UTC(2024, 2, 20, 3, 6, 0) / 1000; // 2024 March equinox
    expect(Math.abs(subsolarPoint(t).lat)).toBeLessThan(0.5);
  });

  it("subsolar longitude tracks local noon (sun overhead near 0° lon at ~12:00 UTC)", () => {
    const t = Date.UTC(2024, 2, 20, 12, 0, 0) / 1000;
    expect(Math.abs(subsolarPoint(t).lon)).toBeLessThan(5); // within a few degrees of the prime meridian
  });
});

describe("sun — terminator latitude", () => {
  it("is the antipodal-symmetric great circle (90° from the subsolar point)", () => {
    const sub = { lat: 10, lon: 0 };
    // a point on the terminator is exactly 90° (≈10018 km) from the subsolar point
    const lat = terminatorLatitude(0, sub);
    const quarter = Math.PI * 6371000 / 2;
    expect(haversineMeters(lat, 0, sub.lat, sub.lon)).toBeCloseTo(quarter, -4);
  });
});

describe("geo — great-circle arc (docs/design/11 bearing arc)", () => {
  it("returns steps+1 points with exact endpoints", () => {
    const arc = greatCircleArc(47.07, 15.42, 40.7128, -74.006, 32); // Graz → NYC
    expect(arc).toHaveLength(33);
    expect(arc[0]).toEqual([15.42, 47.07]);
    expect(arc[arc.length - 1]).toEqual([-74.006, 40.7128]);
  });

  it("the midpoint lies ~half the total distance from each end", () => {
    const a = [48, 11] as const, b = [48, 31] as const; // same latitude, 20° of lon apart
    const arc = greatCircleArc(a[0], a[1], b[0], b[1], 64);
    const mid = arc[32]!;
    const half = haversineMeters(a[0], a[1], b[0], b[1]) / 2;
    expect(haversineMeters(a[0], a[1], mid[1], mid[0])).toBeCloseTo(half, -3);
    // a great circle between two equal-latitude points bows poleward of the rhumb line
    expect(mid[1]).toBeGreaterThan(48);
  });
});
