/** Great-circle distance in metres (local copy; the web doesn't depend on @aprsweb/aprs). */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000, d = Math.PI / 180;
  const dLat = (bLat - aLat) * d, dLon = (bLon - aLon) * d;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * d) * Math.cos(bLat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
