// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedregion.ts — the region filter on the caches sync feed. A subscriber that wants only the caches of
 * one area (a phone before a trip) asks `GET /federation/sync/cache?…&bbox=S,W,N,E`; a publisher that
 * serves the filter says so with the `sync-cache-bbox` capability in its descriptor. Only the caches
 * feed is filtered: deletes (tombstones), keys and account moves always travel whole, so a region never
 * hides a delete.
 *
 * A box is south, west, north, east in decimal degrees. West greater than east crosses the antimeridian.
 */

/** The descriptor capability of a publisher that filters its caches feed by `bbox`. */
export const SYNC_REGION_CAPABILITY = "sync-cache-bbox";

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const NUM_RE = /^-?\d{1,3}(?:\.\d{1,7})?$/;

/** Parse `S,W,N,E`; null for anything else (a malformed number, a latitude out of range, south > north). */
export function parseBbox(raw: string | null | undefined): Bbox | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 4 || !parts.every((p) => NUM_RE.test(p))) return null;
  const [south, west, north, east] = parts.map(Number) as [number, number, number, number];
  if (south < -90 || north > 90 || south > north) return null;
  if (west < -180 || west > 180 || east < -180 || east > 180) return null;
  return { south, west, north, east };
}

/** The normalised `S,W,N,E` form a cursor is stored under and a request carries. */
export function bboxKey(b: Bbox): string {
  return [b.south, b.west, b.north, b.east].map(String).join(",");
}

/** The SQL condition (and its parameters) selecting rows whose `lat`/`lon` columns lie inside `b`. */
export function bboxWhere(b: Bbox): { sql: string; params: number[] } {
  const lon = b.west <= b.east ? "lon BETWEEN ? AND ?" : "(lon >= ? OR lon <= ?)";
  return { sql: `lat BETWEEN ? AND ? AND ${lon}`, params: [b.south, b.north, b.west, b.east] };
}
