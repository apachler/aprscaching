// SPDX-License-Identifier: MIT
/**
 * ultimeter.ts — decoder for Peet Bros Ultimeter weather-station serial output (docs/17 W4, the
 * browser-direct PWS over Web Serial). Two ASCII packet formats:
 *   - Packet Mode      `!!` + 4-hex fields  (wind, dir, temp, rain-total, baro, indoor-T, RH, …)
 *   - Data Logger Mode `$ULTW` + 4-hex fields (peak wind, dir, temp, rain-total, baro, …, RH, …)
 * Each field is a 16-bit big-endian hex value (`----` = no sensor). Output is metric so it feeds the
 * same `sensor_readings` path as the rest of W1–W3. Pure + runtime-neutral; no hardware here.
 */
export interface UltimeterReading {
  windKn?: number; windDirDeg?: number; tempC?: number; humidity?: number;
  pressureHpa?: number; rainTodayMm?: number; rainTotalMm?: number;
}

const KPH_TO_KN = 0.539957;
const MM_PER_HUNDREDTH_INCH = 0.254;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The i-th 4-hex field as an unsigned 16-bit int; undefined for `----` / short / non-hex. */
function field(body: string, i: number): number | undefined {
  const h = body.slice(i * 4, i * 4 + 4);
  if (h.length < 4 || /[^0-9a-fA-F]/.test(h)) return undefined;
  return parseInt(h, 16);
}
const signed16 = (v: number | undefined): number | undefined => (v == null ? undefined : v > 0x7fff ? v - 0x10000 : v);

/**
 * Decode one Ultimeter line into a metric reading, or null if it isn't a recognised packet / carries
 * no usable field. Field offsets follow the published Ultimeter-2100 protocol; humidity and
 * rain-today sit at different indices in the two modes.
 */
export function decodeUltimeter(raw: string): UltimeterReading | null {
  const line = raw.trim();
  let mode: "pkt" | "ultw";
  let body: string;
  if (line.startsWith("$ULTW")) { mode = "ultw"; body = line.slice(5); }
  else if (line.startsWith("!!")) { mode = "pkt"; body = line.slice(2); }
  else return null;
  body = body.replace(/[^0-9a-fA-F-]/g, ""); // drop CR/LF and any trailing checksum punctuation

  const out: UltimeterReading = {};
  const wind = field(body, 0); if (wind != null) out.windKn = r1((wind / 10) * KPH_TO_KN);     // 0.1 kph
  const dir = field(body, 1); if (dir != null) out.windDirDeg = Math.round((dir % 256) * 360 / 256) % 360; // 0–255
  const temp = signed16(field(body, 2)); if (temp != null) out.tempC = r1(((temp / 10) - 32) * 5 / 9);     // 0.1 °F
  const rainTot = field(body, 3); if (rainTot != null) out.rainTotalMm = r1(rainTot * MM_PER_HUNDREDTH_INCH);
  const baro = field(body, 4); if (baro != null && baro > 0) out.pressureHpa = r1(baro / 10);   // 0.1 mbar = 0.1 hPa

  const humIdx = mode === "pkt" ? 6 : 8;       // outdoor humidity (0.1 %)
  const rainTodayIdx = mode === "pkt" ? 10 : 11; // rain since midnight (0.01 in)
  const hum = field(body, humIdx); if (hum != null) out.humidity = Math.min(100, r1(hum / 10));
  const rainToday = field(body, rainTodayIdx); if (rainToday != null) out.rainTodayMm = r1(rainToday * MM_PER_HUNDREDTH_INCH);

  return Object.keys(out).length ? out : null;
}
