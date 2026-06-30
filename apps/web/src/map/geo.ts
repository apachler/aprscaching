// Maidenhead pair bases (lon and lat share them): field=18 letters, square=10 digits,
// subsquare=24 letters, then extended digit/letter pairs for higher precision (F-7).
const MH_BASES = [18, 10, 24, 10, 24];
/**
 * Maidenhead grid locator from lat/lon — the ham-native coordinate the UI shows. `chars` selects the
 * precision: 6 (default, ~5 km, back-compat with existing callers) up to 10 (extended subsquare,
 * ~0.5 km). Even values 2..10; the 6-char output is identical to the previous implementation.
 */
export function maidenhead(lat: number, lon: number, chars = 6): string {
  const n = Math.max(2, Math.min(10, chars - (chars % 2)));
  let lonRem = ((((lon + 180) % 360) + 360) % 360);
  let latRem = Math.min(((((lat + 90) % 180) + 180) % 180), 179.999999);
  let lonCell = 360, latCell = 180, out = "";
  for (let p = 0; p < n / 2; p++) {
    lonCell /= MH_BASES[p]!; latCell /= MH_BASES[p]!;
    const li = Math.floor(lonRem / lonCell), ai = Math.floor(latRem / latCell);
    lonRem -= li * lonCell; latRem -= ai * latCell;
    const base = p === 0 ? 65 : p % 2 === 1 ? 48 : 97; // field A-R · digit 0-9 · subsquare a-x
    out += String.fromCharCode(base + li) + String.fromCharCode(base + ai);
  }
  return out;
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

/** Inverse of maidenhead(): centre lat/lon of a 4/6/8/10-char locator, or null if malformed. */
export function gridCenter(grid: string): [number, number] | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2}([A-X]{2})?)?)?$/.test(g)) return null;
  const pairs = g.match(/../g)!;
  let lon = -180, lat = -90, lonCell = 360, latCell = 180;
  for (let p = 0; p < pairs.length; p++) {
    lonCell /= MH_BASES[p]!; latCell /= MH_BASES[p]!;
    const base = p === 0 || p % 2 === 0 ? 65 : 48; // letters A-X (field/subsquare) or digits 0-9
    lon += (pairs[p]!.charCodeAt(0) - base) * lonCell;
    lat += (pairs[p]!.charCodeAt(1) - base) * latCell;
  }
  return [lat + latCell / 2, lon + lonCell / 2]; // centre of the smallest cell
}

/** Great-circle distance in metres (local copy; the web doesn't depend on @aprsweb/aprs). */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000, d = Math.PI / 180;
  const dLat = (bLat - aLat) * d, dLon = (bLon - aLon) * d;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * d) * Math.cos(bLat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
