// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Radio coverage for the hide form, pure: the range circles drawn on the map, what reaches the hider's pin, and
 * the one line that says what a find there can reach. A find reaches Tier A only when an attested receiving site
 * hears the finder on the air; a frame a digipeater or IGate carries reaches the instance over APRS-IS and stays
 * Tier C; a find logged in the app at the cache reaches Tier B wherever the phone has a fix.
 */
import type * as GeoJSON from "geojson";
import { COVERAGE_MAX_KM, type CoverageSite } from "@aprscaching/shared";
import { haversine } from "../map/geo.js";
import type { BBox } from "../api.js";

const R_KM = 6371.0088;
const RAD = Math.PI / 180;

/**
 * A geodesic circle of `km` around a point as a closed GeoJSON ring of `[lon, lat]`, `steps` points around: each
 * the destination point at that bearing on a sphere, so the circle stays round at any latitude.
 */
export function circleRing(lat: number, lon: number, km: number, steps = 64): [number, number][] {
  const d = km / R_KM;
  const phi1 = lat * RAD;
  const lam1 = lon * RAD;
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const brg = (2 * Math.PI * i) / steps;
    const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(brg));
    const lam2 =
      lam1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2));
    ring.push([+(((lam2 / RAD + 540) % 360) - 180).toFixed(6), +(phi2 / RAD).toFixed(6)]);
  }
  ring.push(ring[0]!);
  return ring;
}

/** Whether a site is an attested receiving site (a hearing there makes a find Tier A). */
export const isAttested = (s: CoverageSite): boolean => s.kind === "attested";

/**
 * The circles as GeoJSON polygons, the attested sites last so they draw on top. Each carries `attested` and
 * `estimated` for the layer's colour and dash.
 */
export function coverageFeatures(sites: CoverageSite[]): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const ordered = [...sites.filter((s) => !isAttested(s)), ...sites.filter(isAttested)];
  return {
    type: "FeatureCollection",
    features: ordered.map((s) => ({
      type: "Feature",
      properties: { callsign: s.callsign, attested: isAttested(s), estimated: s.estimated },
      geometry: { type: "Polygon", coordinates: [circleRing(s.lat, s.lon, s.rangeKm)] },
    })),
  };
}

/** What reaches a point: an attested site, else a digipeater or IGate, else nothing known; each the nearest. */
export type Reach = { kind: "attested"; call: string } | { kind: "relay"; call: string } | { kind: "none" };

export function reachAt(lat: number, lon: number, sites: CoverageSite[]): Reach {
  let best: { s: CoverageSite; km: number } | null = null;
  for (const s of sites) {
    const km = haversine(lat, lon, s.lat, s.lon) / 1000;
    if (km > s.rangeKm) continue;
    const better =
      !best || (isAttested(s) && !isAttested(best.s)) || (isAttested(s) === isAttested(best.s) && km < best.km);
    if (better) best = { s, km };
  }
  if (!best) return { kind: "none" };
  return { kind: isAttested(best.s) ? "attested" : "relay", call: best.s.callsign };
}

/**
 * The line under the location picker for what reaches the pin, and its tone. `radioOnly` is the hider's
 * Radio-verified finds only switch: off an attested site's range, such a cache may never see a verified find.
 */
export function reachText(r: Reach, radioOnly = false): { text: string; tone: "ok" | "warn"; call?: string } {
  if (r.kind === "attested")
    return {
      text: `Inside an attested receiver's range (${r.call}): RF finds can reach Tier A.`,
      tone: "ok",
      call: r.call,
    };
  const app = radioOnly
    ? " With Radio-verified finds only on, finds here may never count as verified."
    : " A find logged in the app at the cache can still reach Tier B.";
  if (r.kind === "relay")
    return {
      text: `Only APRS-IS reaches here (through ${r.call}): RF finds stop at Tier C.${app}`,
      tone: "warn",
      call: r.call,
    };
  return { text: `No receiver known in range: RF finds may not be heard at all.${app}`, tone: "warn" };
}

/** The widest box the read API answers, in degrees a side. */
const MAX_SIDE_DEG = 20;

/**
 * The box to ask for around the map's view: wide enough by COVERAGE_MAX_KM on every side that a circle reaching
 * into the view from outside it is in the answer, and never wider than the API answers; null when the view
 * itself is too wide to ask for (zoomed out to a continent).
 */
export function fetchBox(view: BBox): BBox | null {
  const [w, s, e, n] = view;
  if (e - w > MAX_SIDE_DEG || n - s > MAX_SIDE_DEG) return null;
  const midLat = (s + n) / 2;
  const padLat = COVERAGE_MAX_KM / 111.32;
  const padLon = COVERAGE_MAX_KM / (111.32 * Math.max(Math.cos(midLat * RAD), 0.05));
  const half = (lo: number, hi: number, pad: number): [number, number] => {
    const mid = (lo + hi) / 2;
    const r = Math.min((hi - lo) / 2 + pad, MAX_SIDE_DEG / 2);
    return [mid - r, mid + r];
  };
  const [w2, e2] = half(w, e, padLon);
  const [s2, n2] = half(s, n, padLat);
  return [w2, Math.max(s2, -90), e2, Math.min(n2, 90)];
}

/** Whether box `outer` holds box `inner`: the view still inside the box already fetched needs no new request. */
export const boxHolds = (outer: BBox, inner: BBox): boolean =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
