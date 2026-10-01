// SPDX-License-Identifier: MIT
/**
 * Offline packs: what a phone downloads before a trip to hunt without a connection. A pack covers an area
 * — a box, a circle, or a corridor along a route — and holds its caches with the details the cache page
 * needs, the latest logs and the list of images. The gateway builds it in one answer
 * (GET /api/offline/pack); the app stores it and reads it while offline.
 *
 * The limits, the area parameters and the route geometry live here so the gateway and the app agree.
 */
import type { CacheLogEntry, CacheSummary, MapCache } from "./dto.js";

/** At most this many caches in one pack; a larger area is refused with its count. */
export const PACK_MAX_CACHES = 5000;
/** At most this many bytes in one pack, images and map tiles included (the app enforces it). */
export const PACK_MAX_BYTES = 250 * 1024 * 1024;
/** The latest logs a pack holds per cache. */
export const PACK_LOGS_PER_CACHE = 5;
/** The largest box side, in degrees (about 280 km north–south). */
export const PACK_MAX_SPAN_DEG = 2.5;
/** The largest circle radius, in metres. */
export const PACK_MAX_RADIUS_M = 100_000;
/** A route corridor's half-width: at most this, at least {@link PACK_MIN_CORRIDOR_M}, in metres. */
export const PACK_MAX_CORRIDOR_M = 5000;
export const PACK_MIN_CORRIDOR_M = 100;
/** The most route points a request carries (the app simplifies a longer track first). */
export const PACK_MAX_ROUTE_POINTS = 500;

export type PackArea =
  | { kind: "bbox"; bbox: [minLon: number, minLat: number, maxLon: number, maxLat: number] }
  | { kind: "radius"; lat: number; lon: number; radiusM: number }
  | { kind: "route"; points: [lat: number, lon: number][]; corridorM: number };

/** One image of a cache, as its page lists it. */
export interface PackImage {
  id: number;
  url: string;
  contentType: string;
  title: string | null;
  bytes: number;
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

// ---- the area as query parameters --------------------------------------------------------------------

/** The query string for an area: `bbox=`, `lat=&lon=&r=`, or `route=<polyline>&corridor=`. */
export function packAreaQuery(area: PackArea): string {
  const q = new URLSearchParams();
  if (area.kind === "bbox") q.set("bbox", area.bbox.join(","));
  else if (area.kind === "radius") {
    q.set("lat", String(area.lat));
    q.set("lon", String(area.lon));
    q.set("r", String(Math.round(area.radiusM)));
  } else {
    q.set("route", encodePolyline(area.points));
    q.set("corridor", String(Math.round(area.corridorM)));
  }
  return q.toString();
}

/** Read and check an area from query parameters; a string says what is wrong. */
export function parsePackArea(q: URLSearchParams): PackArea | string {
  const num = (k: string) => Number(q.get(k));
  if (q.has("bbox")) {
    const b = (q.get("bbox") ?? "").split(",").map(Number);
    if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) return "bbox is minLon,minLat,maxLon,maxLat";
    const [minLon, minLat, maxLon, maxLat] = b as [number, number, number, number];
    if (minLon >= maxLon || minLat >= maxLat) return "bbox has no area";
    if (maxLon - minLon > PACK_MAX_SPAN_DEG || maxLat - minLat > PACK_MAX_SPAN_DEG)
      return `a pack's box spans at most ${PACK_MAX_SPAN_DEG}° each way`;
    return { kind: "bbox", bbox: [minLon, minLat, maxLon, maxLat] };
  }
  if (q.has("lat") && q.has("lon") && q.has("r")) {
    const lat = num("lat"),
      lon = num("lon"),
      radiusM = num("r");
    if (![lat, lon, radiusM].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || radiusM <= 0)
      return "lat, lon and r (metres) are numbers";
    if (radiusM > PACK_MAX_RADIUS_M) return `a pack's radius is at most ${PACK_MAX_RADIUS_M / 1000} km`;
    return { kind: "radius", lat, lon, radiusM };
  }
  if (q.has("route")) {
    let points: [number, number][];
    try {
      points = decodePolyline(q.get("route") ?? "");
    } catch {
      return "route is an encoded polyline";
    }
    if (points.length < 2) return "a route has at least two points";
    if (points.length > PACK_MAX_ROUTE_POINTS) return `a route has at most ${PACK_MAX_ROUTE_POINTS} points`;
    const corridorM = q.has("corridor") ? num("corridor") : 1000;
    if (!Number.isFinite(corridorM) || corridorM < PACK_MIN_CORRIDOR_M || corridorM > PACK_MAX_CORRIDOR_M)
      return `corridor is ${PACK_MIN_CORRIDOR_M}–${PACK_MAX_CORRIDOR_M} m`;
    const box = areaBounds({ kind: "route", points, corridorM });
    if (box[2] - box[0] > 2 * PACK_MAX_SPAN_DEG || box[3] - box[1] > 2 * PACK_MAX_SPAN_DEG)
      return `a route spans at most ${2 * PACK_MAX_SPAN_DEG}° each way`;
    return { kind: "route", points, corridorM };
  }
  return "give an area: bbox=, lat=&lon=&r=, or route=&corridor=";
}

// ---- geometry ------------------------------------------------------------------------------------------

const M_PER_DEG = 111_320;

/** The bounding box of an area, [minLon, minLat, maxLon, maxLat], widened by a circle or corridor. */
export function areaBounds(area: PackArea): [number, number, number, number] {
  if (area.kind === "bbox") return area.bbox;
  const pts: [number, number][] = area.kind === "radius" ? [[area.lat, area.lon]] : area.points;
  const pad = area.kind === "radius" ? area.radiusM : area.corridorM;
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const [lat, lon] of pts) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  const dLat = pad / M_PER_DEG;
  const dLon = pad / (M_PER_DEG * Math.max(0.01, Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)));
  return [minLon - dLon, Math.max(-90, minLat - dLat), maxLon + dLon, Math.min(90, maxLat + dLat)];
}

/** Metres from a point to the segment a–b, on a local flat projection (exact enough within a corridor). */
function toSegmentM(p: [number, number], a: [number, number], b: [number, number]): number {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * k * M_PER_DEG,
    ay = (a[0] - p[0]) * M_PER_DEG,
    bx = (b[1] - p[1]) * k * M_PER_DEG,
    by = (b[0] - p[0]) * M_PER_DEG;
  const dx = bx - ax,
    dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Is the point inside the area? */
export function inPackArea(area: PackArea, lat: number, lon: number): boolean {
  if (area.kind === "bbox") {
    const [minLon, minLat, maxLon, maxLat] = area.bbox;
    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  }
  if (area.kind === "radius") return toSegmentM([lat, lon], [area.lat, area.lon], [area.lat, area.lon]) <= area.radiusM;
  for (let i = 1; i < area.points.length; i++)
    if (toSegmentM([lat, lon], area.points[i - 1]!, area.points[i]!) <= area.corridorM) return true;
  return false;
}

/** Drop route points that stay within `toleranceM` of the line (Douglas–Peucker), keeping the ends. */
export function simplifyRoute(points: [number, number][], toleranceM: number): [number, number][] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1,
      at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = toSegmentM(points[k]!, points[i]!, points[j]!);
      if (d > worst) [worst, at] = [d, k];
    }
    if (worst > toleranceM) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

// ---- the encoded polyline format (5 decimals), compact enough for a query string ------------------------

export function encodePolyline(points: [number, number][]): string {
  let out = "",
    pLat = 0,
    pLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lat, lon] of points) {
    const iLat = Math.round(lat * 1e5),
      iLon = Math.round(lon * 1e5);
    out += enc(iLat - pLat) + enc(iLon - pLon);
    pLat = iLat;
    pLon = iLon;
  }
  return out;
}

export function decodePolyline(s: string): [number, number][] {
  const pts: [number, number][] = [];
  let i = 0,
    lat = 0,
    lon = 0;
  const next = () => {
    let shift = 0,
      result = 0,
      b: number;
    do {
      if (i >= s.length) throw new Error("polyline ends mid-number");
      b = s.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) throw new Error("polyline has a character outside its alphabet");
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    const p: [number, number] = [lat / 1e5, lon / 1e5];
    if (Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) throw new Error("polyline point outside the globe");
    pts.push(p);
  }
  return pts;
}
