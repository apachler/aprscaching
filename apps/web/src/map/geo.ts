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

/** Great-circle distance in metres (local copy; the web doesn't depend on @aprsweb/aprs). */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000, d = Math.PI / 180;
  const dLat = (bLat - aLat) * d, dLon = (bLon - aLon) * d;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * d) * Math.cos(bLat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
