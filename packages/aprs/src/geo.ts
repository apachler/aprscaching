// SPDX-License-Identifier: MIT
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180,
    la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Initial great-circle bearing A→B in degrees (0–360, 0 = north). */
export function initialBearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = (aLat * Math.PI) / 180,
    φ2 = (bLat * Math.PI) / 180;
  const Δλ = ((bLon - aLon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Point reached travelling `distM` metres from (lat,lon) on `bearingDeg` (great-circle). */
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distM: number,
): { lat: number; lon: number } {
  const R = 6371000;
  const δ = distM / R,
    θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180,
    λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lon: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}

/**
 * `steps + 1` points along the great-circle (shortest-path) arc A→B, as [lon,lat] pairs (GeoJSON
 * order). Spherical interpolation (slerp) so the path bends correctly on a Mercator map; endpoints
 * are exact. `steps` defaults to 64.
 */
export function greatCircleArc(aLat: number, aLon: number, bLat: number, bLon: number, steps = 64): [number, number][] {
  const φ1 = (aLat * Math.PI) / 180,
    λ1 = (aLon * Math.PI) / 180;
  const φ2 = (bLat * Math.PI) / 180,
    λ2 = (bLon * Math.PI) / 180;
  const d = haversineMeters(aLat, aLon, bLat, bLon) / 6371000; // angular distance (rad)
  if (d === 0)
    return [
      [aLon, aLat],
      [bLon, bLat],
    ];
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λ = Math.atan2(y, x);
    out.push([(λ * 180) / Math.PI, (φ * 180) / Math.PI]);
  }
  out[0] = [aLon, aLat];
  out[out.length - 1] = [bLon, bLat]; // pin endpoints exactly (no FP drift)
  return out;
}

export function toMaidenhead(lat: number, lon: number): string {
  lon += 180;
  lat += 90;
  const A = "ABCDEFGHIJKLMNOPQRSTUVWX";
  const f1 = A[Math.floor(lon / 20)]!,
    f2 = A[Math.floor(lat / 10)]!;
  const s1 = Math.floor((lon % 20) / 2),
    s2 = Math.floor(lat % 10);
  const t1 = A[Math.floor((lon % 2) * 12)]!.toLowerCase();
  const t2 = A[Math.floor((lat % 1) * 24)]!.toLowerCase();
  return `${f1}${f2}${s1}${s2}${t1}${t2}`;
}
