// SPDX-License-Identifier: AGPL-3.0-or-later
// The hide form's radio coverage: geodesic range circles, what reaches the pin, the line that says what a find
// there can reach, and the box asked for around the map's view.
import { describe, it, expect } from "vitest";
import type { CoverageSite } from "@aprscaching/shared";
import { boxHolds, circleRing, coverageFeatures, fetchBox, reachAt, reachText } from "../src/caches/coverage.js";
import { haversine } from "../src/map/geo.js";

const site = (
  callsign: string,
  kind: CoverageSite["kind"],
  lat: number,
  lon: number,
  rangeKm: number,
): CoverageSite => ({
  callsign,
  kind,
  lat,
  lon,
  rangeKm,
  estimated: false,
  lastSeen: 0,
});

describe("circleRing", () => {
  it("puts every point the radius from the centre, closed, at any latitude", () => {
    for (const lat of [0, 47.07, 70]) {
      const ring = circleRing(lat, 15.44, 12, 48);
      expect(ring).toHaveLength(49);
      expect(ring[48]).toEqual(ring[0]);
      for (const [lon, la] of ring) expect(haversine(lat, 15.44, la, lon) / 1000).toBeCloseTo(12, 1);
    }
  });

  it("wraps across the antimeridian", () => {
    for (const [lon] of circleRing(10, 179.9, 50)) expect(Math.abs(lon)).toBeLessThanOrEqual(180);
  });
});

describe("coverageFeatures", () => {
  it("draws the attested sites last, with their kind and estimate as properties", () => {
    const fc = coverageFeatures([
      site("OE6XGR-10", "attested", 47.07, 15.43, 5),
      { ...site("OE6XRR-3", "digipeater", 47.08, 15.5, 10), estimated: true },
    ]);
    expect(fc.features.map((f) => f.properties)).toEqual([
      { callsign: "OE6XRR-3", attested: false, estimated: true },
      { callsign: "OE6XGR-10", attested: true, estimated: false },
    ]);
  });
});

describe("reachAt", () => {
  const sites = [
    site("OE6XRR-3", "digipeater", 47.1, 15.5, 30),
    site("OE6XGR-10", "attested", 47.07, 15.43, 5),
    site("OE6IGT", "igate", 47.0, 15.4, 8),
  ];

  it("names an attested site over a nearer digipeater", () => {
    expect(reachAt(47.071, 15.431, sites)).toEqual({ kind: "attested", call: "OE6XGR-10" });
  });

  it("falls back to the nearest digipeater or IGate outside every attested range", () => {
    expect(reachAt(47.0, 15.401, sites)).toEqual({ kind: "relay", call: "OE6IGT" });
    expect(reachAt(47.25, 15.6, sites)).toEqual({ kind: "relay", call: "OE6XRR-3" });
  });

  it("knows no receiver beyond every range", () => {
    expect(reachAt(48.5, 11.5, sites)).toEqual({ kind: "none" });
    expect(reachAt(47.07, 15.43, [])).toEqual({ kind: "none" });
  });
});

describe("reachText", () => {
  it("says Tier A is reachable inside an attested range", () => {
    const r = reachText({ kind: "attested", call: "OE6XGR-10" });
    expect(r.tone).toBe("ok");
    expect(r.text).toContain("Tier A");
    expect(r.text).toContain("OE6XGR-10");
  });

  it("warns that RF finds stop at Tier C where only APRS-IS reaches, and Tier B stays open in the app", () => {
    const r = reachText({ kind: "relay", call: "OE6XRR-3" });
    expect(r.tone).toBe("warn");
    expect(r.text).toMatch(/^Only APRS-IS reaches here/);
    expect(r.text).toContain("Tier C");
    expect(r.text).toContain("Tier B");
  });

  it("warns a Radio-verified-only cache off every attested range", () => {
    const r = reachText({ kind: "none" }, true);
    expect(r.tone).toBe("warn");
    expect(r.text).toContain("Radio-verified finds only");
    expect(r.text).not.toContain("Tier B");
  });
});

describe("fetchBox", () => {
  it("pads the view so circles reaching in from outside are in the answer", () => {
    const view: [number, number, number, number] = [15.3, 47.0, 15.6, 47.15];
    const box = fetchBox(view)!;
    expect(boxHolds(box, view)).toBe(true);
    expect(box[1]).toBeLessThan(view[1] - 0.8);
    expect(box[0]).toBeLessThan(view[0] - 1.2);
  });

  it("never asks for more than 20 degrees a side, and nothing for a continent", () => {
    const box = fetchBox([5, 40, 23, 55])!;
    expect(box[2] - box[0]).toBeLessThanOrEqual(20);
    expect(box[3] - box[1]).toBeLessThanOrEqual(20);
    expect(fetchBox([-30, 30, 40, 60])).toBeNull();
  });
});
