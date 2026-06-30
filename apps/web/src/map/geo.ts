/** Maidenhead grid locator (6-char) from lat/lon — the ham-native coordinate the operator UI shows. */
export function maidenhead(lat: number, lon: number): string {
  const L = lon + 180, B = lat + 90;
  const f = (x: number, d: number) => Math.floor(x / d);
  return (
    String.fromCharCode(65 + f(L, 20)) + String.fromCharCode(65 + f(B, 10)) +
    String.fromCharCode(48 + f(L % 20, 2)) + String.fromCharCode(48 + f(B % 10, 1)) +
    String.fromCharCode(97 + f((L % 2) * 60, 5)) + String.fromCharCode(97 + f((B % 1) * 60, 2.5))
  );
}

const OCTANT = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Initial great-circle bearing in degrees (0–360) of point B as seen from point A. */
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const d = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * d) * Math.cos(bLat * d);
  const x = Math.cos(aLat * d) * Math.sin(bLat * d) - Math.sin(aLat * d) * Math.cos(bLat * d) * Math.cos((bLon - aLon) * d);
  return (Math.atan2(y, x) / d + 360) % 360;
}
/** Compass octant (N/NE/…/NW) of point B as seen from point A. */
export function bearing8(aLat: number, aLon: number, bLat: number, bLon: number): string {
  return OCTANT[Math.round(bearingDeg(aLat, aLon, bLat, bLon) / 45) % 8]!;
}

/** Inverse of maidenhead(): centre lat/lon of a 4- or 6-char locator, or null if malformed. */
export function gridCenter(grid: string): [number, number] | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + (g.charCodeAt(2) - 48) * 2;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90 + (g.charCodeAt(3) - 48);
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24) + 1 / 24;
    lat += (g.charCodeAt(5) - 65) * (1 / 24) + 0.5 / 24;
  } else { lon += 1; lat += 0.5; }
  return [lat, lon];
}

/** Great-circle distance in metres (local copy; the web doesn't depend on @aprsweb/aprs). */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000, d = Math.PI / 180;
  const dLat = (bLat - aLat) * d, dLon = (bLon - aLon) * d;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * d) * Math.cos(bLat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
