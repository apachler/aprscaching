export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180, la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function toMaidenhead(lat: number, lon: number): string {
  lon += 180; lat += 90;
  const A = "ABCDEFGHIJKLMNOPQRSTUVWX";
  const f1 = A[Math.floor(lon / 20)]!, f2 = A[Math.floor(lat / 10)]!;
  const s1 = Math.floor((lon % 20) / 2), s2 = Math.floor(lat % 10);
  const t1 = A[Math.floor((lon % 2) * 12)]!.toLowerCase();
  const t2 = A[Math.floor((lat % 1) * 24)]!.toLowerCase();
  return `${f1}${f2}${s1}${s2}${t1}${t2}`;
}
