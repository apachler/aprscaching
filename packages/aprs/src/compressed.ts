// SPDX-License-Identifier: MIT
/**
 * compressed.ts — APRS base-91 compressed position (APRS101 §9 "Compressed Position Report Format").
 * Layout (13 bytes): /YYYYXXXX$csT
 *   [0]      symbol table id
 *   [1..4]   latitude  (4 × base-91 digits)
 *   [5..8]   longitude (4 × base-91 digits)
 *   [9]      symbol code
 *   [10..11] compression of course/speed OR pre-calculated radio range OR altitude
 *   [12]     compression type byte (tells you which of the above [10..11] holds)
 */
export interface CompressedFix {
  lat: number;
  lon: number;
  table: string;
  code: string;
  course?: number;
  speedKn?: number;
  altitudeM?: number;
  rangeKm?: number;
}

const d = (c: string) => c.charCodeAt(0) - 33; // base-91 digit
function isCompressedLead(c: string): boolean {
  // symbol table for compressed reports: '/', '\', or overlay 'A'-'Z' / 'a'-'j'
  return c === "/" || c === "\\" || (c >= "A" && c <= "Z") || (c >= "a" && c <= "j");
}

/** Parse a compressed position starting at `s` (s[0] = symbol table). null if not compressed. */
export function parseCompressed(s: string): CompressedFix | null {
  if (s.length < 13 || !isCompressedLead(s[0]!)) return null;
  for (let i = 1; i <= 8; i++) {
    const v = d(s[i]!);
    if (v < 0 || v > 90) return null;
  }

  const y = d(s[1]!) * 753571 + d(s[2]!) * 8281 + d(s[3]!) * 91 + d(s[4]!);
  const x = d(s[5]!) * 753571 + d(s[6]!) * 8281 + d(s[7]!) * 91 + d(s[8]!);
  const lat = 90 - y / 380926;
  const lon = -180 + x / 190463;

  const table = s[0]!,
    code = s[9]!;
  const c = s[10]!,
    cc = s[11]!,
    t = s[12]!;
  const fix: CompressedFix = { lat, lon, table, code };

  if (c !== " ") {
    const tByte = t.charCodeAt(0) - 33;
    if ((tByte & 0x18) === 0x10) {
      // altitude: cs = altitude in feet as 1.002^(c*91+cc)
      const alt = Math.pow(1.002, d(c) * 91 + d(cc));
      fix.altitudeM = Math.round(alt * 0.3048 * 10) / 10;
    } else if (d(c) >= 0 && d(c) <= 89) {
      // course/speed: course = c*4 deg, speed = 1.08^cc - 1 knots
      fix.course = d(c) * 4;
      fix.speedKn = Math.round((Math.pow(1.08, d(cc)) - 1) * 10) / 10;
    } else if (c === "{") {
      // pre-calculated radio range: 2 * 1.08^cc miles
      fix.rangeKm = Math.round(2 * Math.pow(1.08, d(cc)) * 1.609 * 10) / 10;
    }
  }
  return fix;
}
