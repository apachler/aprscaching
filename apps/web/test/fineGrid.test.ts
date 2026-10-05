// SPDX-License-Identifier: AGPL-3.0-or-later
// The graticule's close-up grid: lines across the view only, closer as the map zooms in, none when zoomed out.
import { describe, expect, it } from "vitest";
import { fineGridLines } from "../src/offlineBasemap.js";

const graz = { west: 15.4, south: 47.05, east: 15.46, north: 47.09 };
const coords = (fc: ReturnType<typeof fineGridLines>) =>
  fc.features.map((f) => (f.geometry as { coordinates: [number, number][] }).coordinates);

describe("the close-up grid", () => {
  it("is empty below zoom 11, where the 0.1° grid shows", () => {
    expect(fineGridLines(graz, 10).features).toEqual([]);
  });

  it("draws every 0.01° across a street-level view, one step past each edge", () => {
    const lines = coords(fineGridLines(graz, 14));
    const meridians = lines.filter(([a, b]) => a![0] === b![0]).map(([a]) => a![0]);
    expect(meridians[0]).toBe(15.39);
    expect(meridians.at(-1)).toBe(15.47);
    expect(meridians).toHaveLength(9);
    const parallels = lines.filter(([a, b]) => a![1] === b![1]).map(([a]) => a![1]);
    expect(parallels).toEqual([47.04, 47.05, 47.06, 47.07, 47.08, 47.09, 47.1]);
  });

  it("goes to 0.001° from zoom 15, and draws none for a view too wide for its zoom", () => {
    const close = { west: 15.43, south: 47.07, east: 15.435, north: 47.073 };
    const lines = coords(fineGridLines(close, 16));
    expect(lines.some(([a]) => a![0] === 15.431)).toBe(true);
    expect(fineGridLines({ west: 0, south: 0, east: 10, north: 10 }, 15).features).toEqual([]);
  });
});
