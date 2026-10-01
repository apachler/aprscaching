// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  areaBounds,
  decodePolyline,
  encodePolyline,
  inPackArea,
  packAreaQuery,
  parsePackArea,
  simplifyRoute,
  type PackArea,
} from "../src/offlinepack.js";

describe("the encoded polyline", () => {
  it("round-trips to 5 decimals", () => {
    const pts: [number, number][] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    expect(encodePolyline(pts)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@"); // the format's reference example
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
  });
  it("refuses a malformed string", () => {
    expect(() => decodePolyline("!!!")).toThrow();
    expect(() => decodePolyline("_p~iF~ps|U_")).toThrow();
  });
});

describe("the area", () => {
  it("round-trips through the query string", () => {
    for (const a of [
      { kind: "bbox", bbox: [15, 47, 15.5, 47.5] },
      { kind: "radius", lat: 47, lon: 15, radiusM: 5000 },
      {
        kind: "route",
        points: [
          [47, 15],
          [47.1, 15.2],
        ],
        corridorM: 800,
      },
    ] as PackArea[])
      expect(parsePackArea(new URLSearchParams(packAreaQuery(a)))).toEqual(a);
  });
  it("names what is wrong", () => {
    expect(parsePackArea(new URLSearchParams("bbox=1,2,3"))).toMatch(/bbox/);
    expect(parsePackArea(new URLSearchParams("bbox=10,40,15,45"))).toMatch(/spans/);
    expect(parsePackArea(new URLSearchParams(`route=${encodePolyline([[47, 15]])}`))).toMatch(/two points/);
    expect(
      parsePackArea(
        new URLSearchParams(
          `route=${encodePolyline([
            [47, 15],
            [47, 16],
          ])}&corridor=50`,
        ),
      ),
    ).toMatch(/corridor/);
  });
  it("tests a point against a circle and a corridor", () => {
    const circle: PackArea = { kind: "radius", lat: 47, lon: 15, radiusM: 1000 };
    expect(inPackArea(circle, 47.005, 15)).toBe(true); // ~560 m
    expect(inPackArea(circle, 47.02, 15)).toBe(false); // ~2.2 km
    const route: PackArea = {
      kind: "route",
      points: [
        [47, 15],
        [47, 15.1],
      ],
      corridorM: 200,
    };
    expect(inPackArea(route, 47.001, 15.05)).toBe(true); // ~110 m off the line
    expect(inPackArea(route, 47.01, 15.05)).toBe(false);
    expect(inPackArea(route, 47, 15.11)).toBe(false); // past the end
  });
  it("bounds a circle by its radius", () => {
    const [minLon, minLat, maxLon, maxLat] = areaBounds({ kind: "radius", lat: 0, lon: 0, radiusM: 111_320 });
    expect([minLon, minLat, maxLon, maxLat].map((n) => Math.round(n * 100) / 100)).toEqual([-1, -1, 1, 1]);
  });
});

describe("route simplification", () => {
  it("drops points close to the line and keeps the bends and the ends", () => {
    const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [47, 15 + i * 0.001]);
    line.push([47.05, 15.05]);
    const s = simplifyRoute(line, 50);
    expect(s[0]).toEqual(line[0]);
    expect(s.at(-1)).toEqual([47.05, 15.05]);
    expect(s).toContainEqual(line[49]);
    expect(s.length).toBe(3);
  });
});
