// SPDX-License-Identifier: MIT
/**
 * Offline packs: what a phone downloads before a trip to hunt without a connection. A pack covers a
 * Maidenhead locator square and holds its caches with the details the cache page needs, the latest logs
 * and the list of images. The gateway builds it in one answer
 * (GET /api/offline/pack); the app stores it and reads it while offline.
 *
 * The limits and the locator arithmetic live here so the gateway and the app agree.
 */
import type { CacheLogEntry, CacheSummary, MapCache } from "./dto.js";

/** At most this many caches in one pack; a larger area is refused with its count. */
export const PACK_MAX_CACHES = 5000;
/** At most this many bytes in one pack, images and map tiles included (the app enforces it). */
export const PACK_MAX_BYTES = 250 * 1024 * 1024;
/** The latest logs a pack holds per cache. */
export const PACK_LOGS_PER_CACHE = 5;

/**
 * A pack's area is one Maidenhead locator square, the grid every ham already uses: a field (`JN`,
 * 20° × 10°), a square (`JN77`, 2° × 1°), a subsquare (`JN77sb`, about 6 × 4.6 km here), or an extended
 * square (`JN77sb42`, about 600 × 460 m). A longer locator is a smaller pack.
 */
export interface PackArea {
  locator: string;
}

/** One image of a cache, as its page lists it. */
export interface PackImage {
  id: number;
  url: string;
  contentType: string;
  title: string | null;
  bytes: number;
  /** The small copy stored beside the image (the gallery's and a thumbnail pack's), when there is one. */
  thumbUrl: string | null;
  thumbBytes: number | null;
}

/** A cache as a pack holds it: the map fields, the page details, its stages' shape and latest logs. */
export interface PackCache
  extends MapCache, Pick<CacheSummary, "stationCall" | "minTrust" | "fedScope" | "driveIn" | "country" | "tags"> {
  externalId: string | null;
  hint: string | null;
  description: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** The stages after the published start: their number and how each unlocks. Never coordinates or clues. */
  stages: { stageNo: number; unlock: string }[];
  logs: CacheLogEntry[];
  images: PackImage[];
}

export interface PackResponse {
  instance: string;
  /** Changes whenever anything in the pack would; the ETag. */
  generation: string;
  builtAt: number;
  caches: PackCache[];
}

// ---- the locator --------------------------------------------------------------------------------------

const LOCATOR = /^[A-R]{2}(?:[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?)?$/;

/** A locator in its usual spelling (field and square upper case, subsquare lower case), or null. */
export function normalizeLocator(input: string): string | null {
  const g = input.trim().toUpperCase();
  if (!LOCATOR.test(g)) return null;
  return g.slice(0, 4) + g.slice(4, 6).toLowerCase() + g.slice(6);
}

/** The square a locator names, as [minLon, minLat, maxLon, maxLat]. */
export function locatorBounds(locator: string): [number, number, number, number] {
  const g = locator.toUpperCase();
  let lon = -180,
    lat = -90,
    w = 360,
    h = 180;
  const steps: [number, number][] = [
    [18, 65], // field A–R
    [10, 48], // square 0–9
    [24, 65], // subsquare a–x
    [10, 48], // extended 0–9
  ];
  for (let i = 0; i * 2 < g.length; i++) {
    const [n, base] = steps[i]!;
    w /= n;
    h /= n;
    lon += (g.charCodeAt(i * 2) - base) * w;
    lat += (g.charCodeAt(i * 2 + 1) - base) * h;
  }
  return [lon, lat, lon + w, lat + h];
}

/** The query string for an area. */
export const packAreaQuery = (area: PackArea): string => `grid=${encodeURIComponent(area.locator)}`;

/** Read and check an area from query parameters; a string says what is wrong. */
export function parsePackArea(q: URLSearchParams): PackArea | string {
  const locator = normalizeLocator(q.get("grid") ?? "");
  if (!locator)
    return "grid is a Maidenhead locator: a field (JN), square (JN77), subsquare (JN77sb) or extended (JN77sb42)";
  return { locator };
}

/** The bounding box of an area, [minLon, minLat, maxLon, maxLat]. */
export const areaBounds = (area: PackArea): [number, number, number, number] => locatorBounds(area.locator);

/** Is the point inside the area? A point on the shared edge of two squares belongs to both. */
export function inPackArea(area: PackArea, lat: number, lon: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = locatorBounds(area.locator);
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}
