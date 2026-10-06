// SPDX-License-Identifier: AGPL-3.0-or-later
// Zoomed out, cache pins that would overlap on screen share one count marker.
import { describe, expect, it } from "vitest";
import { boundsOf, clusterByScreen } from "../src/map/cluster.js";

const at = (p: { x: number; y: number }) => p;

describe("cache pin clusters", () => {
  it("gather pins within the radius of a group's first pin, in list order", () => {
    const pts = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 20, y: 0 },
      { id: "c", x: 100, y: 100 },
      { id: "d", x: 0, y: 30 },
      { id: "e", x: 110, y: 100 },
    ];
    expect(clusterByScreen(pts, at, 34).map((g) => g.map((p) => p.id).join(""))).toEqual(["abd", "ce"]);
  });

  it("leave pins apart when they do not overlap", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ];
    expect(clusterByScreen(pts, at, 34)).toHaveLength(2);
  });

  it("box a group for the zoom that parts it", () => {
    expect(
      boundsOf([
        { lat: 47, lon: 15 },
        { lat: 47.2, lon: 15.5 },
      ]),
    ).toEqual([
      [15, 47],
      [15.5, 47.2],
    ]);
  });
});
