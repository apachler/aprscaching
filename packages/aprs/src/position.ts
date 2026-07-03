// SPDX-License-Identifier: MIT
/** Minimal uncompressed APRS position parser (lat/lon). MIC-E/compressed/weather = M1+. */
export interface PositionFix {
  lat: number;
  lon: number;
  symbol?: string;
}
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

export interface FormatPositionOpts {
  table?: string;
  code?: string;
  dataType?: string;
  course?: number;
  speedKn?: number;
  altitudeM?: number;
  comment?: string;
}
/** Build an uncompressed APRS position payload (used to normalise CoT/Meshtastic fixes). */
export function formatPosition(lat: number, lon: number, o: FormatPositionOpts = {}): string {
  const dm = (v: number, deg: number) => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    // SR-PARSE-04: carry a `60.00'` rounding overflow into degrees so we never emit e.g. `4560.00N`.
    let cm = Math.round((a - d) * 60 * 100);
    if (cm >= 6000) {
      d += 1;
      cm -= 6000;
    }
    return `${String(d).padStart(deg, "0")}${(cm / 100).toFixed(2).padStart(5, "0")}`;
  };
  const ns = lat >= 0 ? "N" : "S",
    ew = lon >= 0 ? "E" : "W";
  const table = o.table ?? "/",
    code = o.code ?? ">";
  let s = `${o.dataType ?? "="}${dm(lat, 2)}${ns}${table}${dm(lon, 3)}${ew}${code}`;
  if (o.course != null && o.speedKn != null)
    s += `${String(Math.round(o.course)).padStart(3, "0")}/${String(Math.round(o.speedKn)).padStart(3, "0")}`;
  if (o.altitudeM != null) s += `/A=${String(Math.round(o.altitudeM / 0.3048)).padStart(6, "0")}`;
  if (o.comment) s += o.comment;
  return s;
}
