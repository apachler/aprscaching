// SPDX-License-Identifier: MIT
/**
 * mgrs.ts — WGS84 lat/lon → MGRS (Military Grid Reference System), for the map's grid/coord readout
 *. Standard UTM forward projection + 100 km square lettering. The rare UTM zone
 * exceptions (Norway 31V/32V, Svalbard) are not special-cased — fine for a display readout.
 */
const COLS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"]; // 100km column letters by (zone-1)%3
const ROWS_ODD = "ABCDEFGHJKLMNPQRSTUV"; // 100km row letters, odd zones (even zones +5)
const BANDS = "CDEFGHJKLMNPQRSTUVWX"; // latitude bands, -80°..84° in 8° steps (X = 12°)

const pad5 = (n: number) => String(Math.floor(n) % 100000).padStart(5, "0");

/** Latitude → MGRS band letter. */
function band(lat: number): string {
  // The X band is a 12° span (72–84°), not just ≥84. Otherwise 80–84° would index
  // BANDS[20] (undefined) and wrongly return "Z".
  if (lat >= 72) return "X";
  if (lat < -80) return "C";
  return BANDS[Math.floor((lat + 80) / 8)] ?? "Z";
}

/**
 * lat/lon → MGRS string e.g. "33U WP 12345 67890" (1 m precision). Returns "" outside MGRS coverage
 * (|lat| > 84/80). `digits` (1–5) sets numeric precision; default 5 (1 m).
 */
export function toMgrs(lat: number, lon: number, digits = 5): string {
  if (lat > 84 || lat < -80) return "";
  const a = 6378137.0,
    f = 1 / 298.257223563,
    k0 = 0.9996;
  const e2 = f * (2 - f),
    ep2 = e2 / (1 - e2);
  const zone = Math.floor((lon + 180) / 6) + 1;
  const λ0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180,
    λ = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(φ) ** 2);
  const T = Math.tan(φ) ** 2;
  const C = ep2 * Math.cos(φ) ** 2;
  const A = Math.cos(φ) * (λ - λ0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * φ -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * φ) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * φ) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * φ));
  const easting =
    k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing =
    k0 *
    (M +
      N *
        Math.tan(φ) *
        (A ** 2 / 2 +
          ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
          ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;

  const colLetters = COLS[(zone - 1) % 3]!;
  const col = colLetters[Math.floor(easting / 100000) - 1] ?? "?";
  let rowIdx = Math.floor(northing / 100000) % 20;
  if (zone % 2 === 0) rowIdx = (rowIdx + 5) % 20; // even zones offset by 5
  const row = ROWS_ODD[rowIdx]!;

  const d = Math.min(Math.max(digits, 1), 5);
  const trim = (v: number) => pad5(v).slice(0, d);
  return `${zone}${band(lat)} ${col}${row} ${trim(easting)} ${trim(northing)}`;
}
