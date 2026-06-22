/** Minimal uncompressed APRS position parser (lat/lon). MIC-E/compressed/weather = M1+. */
export interface PositionFix { lat: number; lon: number; symbol?: string }
const POS_RE = /(\d{2})(\d{2}\.\d{2})([NS]).(\d{3})(\d{2}\.\d{2})([EW])(.)/;

export function parsePosition(payload: string): PositionFix | null {
  const t = payload[0];
  if (t !== "!" && t !== "=" && t !== "/" && t !== "@") return null;
  const m = POS_RE.exec(payload);
  if (!m) return null;
  const [, latDeg, latMin, ns, lonDeg, lonMin, ew, symbol] = m;
  let lat = Number(latDeg) + Number(latMin) / 60;
  let lon = Number(lonDeg) + Number(lonMin) / 60;
  if (ns === "S") lat = -lat;
  if (ew === "W") lon = -lon;
  return { lat, lon, symbol };
}
