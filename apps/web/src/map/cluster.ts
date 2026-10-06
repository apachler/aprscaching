// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Screen-space clustering for the cache pins. Below `CLUSTER_UNTIL_ZOOM`, pins closer than `CLUSTER_RADIUS_PX` on
 * screen gather under one count marker, which zooms in when chosen; from that zoom on every cache has its own pin.
 * The pins stay DOM markers (real buttons with names), so clustering is a grouping of the list, not a style layer.
 * Greedy and in list order, so the same caches at the same zoom always give the same groups.
 */

/** From this zoom on every cache has its own pin. */
export const CLUSTER_UNTIL_ZOOM = 13;
/** Pins nearer than this on screen share a marker. */
export const CLUSTER_RADIUS_PX = 34;

export interface Point {
  x: number;
  y: number;
}

/** Group `items` whose screen points lie within `radius` of a group's first member. */
export function clusterByScreen<T>(items: readonly T[], at: (item: T) => Point, radius: number): T[][] {
  const groups: { seed: Point; items: T[] }[] = [];
  const r2 = radius * radius;
  for (const it of items) {
    const p = at(it);
    const g = groups.find((c) => (c.seed.x - p.x) ** 2 + (c.seed.y - p.y) ** 2 <= r2);
    if (g) g.items.push(it);
    else groups.push({ seed: p, items: [it] });
  }
  return groups.map((g) => g.items);
}

/** The box around a group's positions, as [[west, south], [east, north]]. */
export function boundsOf(points: readonly { lat: number; lon: number }[]): [[number, number], [number, number]] {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const p of points) {
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return [
    [w, s],
    [e, n],
  ];
}
