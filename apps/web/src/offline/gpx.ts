// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A route from a GPX file, for a pack along it: the track points (else the route points, else the
 * waypoints) in order, simplified until the pack request carries at most PACK_MAX_ROUTE_POINTS.
 */
import { PACK_MAX_ROUTE_POINTS, simplifyRoute } from "@aprscaching/shared";

const POINT = /<(trkpt|rtept|wpt)\b[^>]*>/g;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`);

/** The points of a GPX document, or an error message. */
export function routeFromGpx(text: string): [number, number][] | string {
  const by: Record<string, [number, number][]> = { trkpt: [], rtept: [], wpt: [] };
  for (const m of text.matchAll(POINT)) {
    const lat = Number(ATTR("lat").exec(m[0])?.[1]);
    const lon = Number(ATTR("lon").exec(m[0])?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
      by[m[1]!]!.push([lat, lon]);
  }
  const points = by.trkpt!.length > 1 ? by.trkpt! : by.rtept!.length > 1 ? by.rtept! : by.wpt!;
  if (points.length < 2) return "the file has no track or route with two points or more";
  // a looser line until it fits; 10 m keeps a footpath's shape
  let tolerance = 10;
  let s = simplifyRoute(points, tolerance);
  while (s.length > PACK_MAX_ROUTE_POINTS) s = simplifyRoute(points, (tolerance *= 2));
  return s;
}
