// SPDX-License-Identifier: MIT
/**
 * mice.ts — MIC-E decode (APRS101 §10 "Mic-E Data Format").
 * MIC-E packs latitude + message bits into the AX.25 *destination* address, and
 * longitude + speed + course + symbol into the information field. Implemented from the
 * published algorithm (not derived from any third-party source).
 *
 * Destination char encoding (per position):
 *   '0'-'9' -> digit, sign bits 0 (South / +0 / East)
 *   'A'-'J' -> digit 0-9, custom message bit (1C); sign bits "don't care"
 *   'K','L','Z' -> position ambiguity (space)
 *   'P'-'Y' -> digit 0-9, sign bits 1 (North / +100 / West)
 */
export interface MicEFix {
  lat: number;
  lon: number;
  table: string;
  code: string;
  course?: number;
  speedKn?: number;
  altitudeM?: number;
  messageType: string;
  ambiguity: number;
  comment?: string;
}

// standard message table, indexed by the 3 message bits (A,B,C) read as a 3-bit number
const STD_MSG = ["Emergency", "Priority", "Special", "Committed", "Returning", "In Service", "En Route", "Off Duty"];
const CUSTOM_MSG = ["Emergency", "Custom-6", "Custom-5", "Custom-4", "Custom-3", "Custom-2", "Custom-1", "Custom-0"];

function decodeDest(dest: string): {
  digits: number[];
  mbits: number[];
  custom: boolean;
  north: boolean;
  lonOffset: boolean;
  west: boolean;
  ambiguity: number;
} | null {
  const call = dest.split("-")[0]!; // strip SSID
  if (call.length < 6) return null;
  const digits: number[] = [],
    mbits: number[] = [];
  let custom = false,
    ambiguity = 0;
  // sign bits come from chars 3,4,5
  let north = false,
    lonOffset = false,
    west = false;
  for (let i = 0; i < 6; i++) {
    const c = call[i]!;
    let digit = 0,
      mbit = 0,
      high = false,
      space = false;
    if (c >= "0" && c <= "9") {
      digit = c.charCodeAt(0) - 48;
      mbit = 0;
    } else if (c >= "A" && c <= "J") {
      digit = c.charCodeAt(0) - 65;
      mbit = 1;
      custom = true;
    } else if (c === "K") {
      space = true;
      mbit = 1;
      custom = true;
    } else if (c === "L") {
      space = true;
      mbit = 0;
    } else if (c >= "P" && c <= "Y") {
      digit = c.charCodeAt(0) - 80;
      mbit = 1;
      high = true;
    } else if (c === "Z") {
      space = true;
      mbit = 1;
      high = true;
    } else return null;
    if (space) ambiguity++;
    digits.push(digit);
    mbits.push(mbit);
    if (i === 3) north = high;
    if (i === 4) lonOffset = high;
    if (i === 5) west = high;
  }
  return { digits, mbits, custom, north, lonOffset, west, ambiguity };
}

/** Decode a MIC-E frame from its destination address + information field. */
export function decodeMicE(dest: string, info: string): MicEFix | null {
  const dd = decodeDest(dest);
  if (!dd || info.length < 9) return null;
  const [d0, d1, d2, d3, d4, d5] = dd.digits as [number, number, number, number, number, number];

  // latitude DDMM.hh from the 6 destination digits
  const latDeg = d0 * 10 + d1;
  const latMin = d2 * 10 + d3 + (d4 * 10 + d5) / 100;
  let lat = latDeg + latMin / 60;
  if (!dd.north) lat = -lat;

  // longitude from info bytes 1..3 (byte 0 is the MIC-E type id)
  let lonDeg = info.charCodeAt(1) - 28;
  if (dd.lonOffset) lonDeg += 100;
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
  let lonMin = info.charCodeAt(2) - 28;
  if (lonMin >= 60) lonMin -= 60;
  const lonHund = info.charCodeAt(3) - 28;
  let lon = lonDeg + (lonMin + lonHund / 100) / 60;
  if (dd.west) lon = -lon;

  // speed (knots) + course (deg) from info bytes 4..6
  const sp = info.charCodeAt(4) - 28,
    dc = info.charCodeAt(5) - 28,
    se = info.charCodeAt(6) - 28;
  let speedKn = sp * 10 + Math.floor(dc / 10);
  let course = (dc % 10) * 100 + se;
  if (speedKn >= 800) speedKn -= 800;
  if (course >= 400) course -= 400;

  const code = info[7] ?? "/";
  const table = info[8] ?? "/";

  const msgNum = (dd.mbits[0]! << 2) | (dd.mbits[1]! << 1) | dd.mbits[2]!;
  const messageType = (dd.custom ? CUSTOM_MSG : STD_MSG)[msgNum]!;

  const fix: MicEFix = {
    lat: round(lat),
    lon: round(lon),
    table,
    code,
    course,
    speedKn,
    messageType,
    ambiguity: dd.ambiguity,
  };

  // trailing comment may carry altitude as "xxx}" (base-91, metres above -10000m datum)
  const rest = info.slice(9);
  const altM = /(.)(.)(.)}/.exec(rest);
  if (altM && rest.indexOf("}") === 3) {
    const a = (altM[1]!.charCodeAt(0) - 33) * 8281 + (altM[2]!.charCodeAt(0) - 33) * 91 + (altM[3]!.charCodeAt(0) - 33);
    fix.altitudeM = a - 10000;
    fix.comment = rest.slice(4).trim() || undefined;
  } else if (rest.trim()) {
    fix.comment = rest.trim();
  }
  return fix;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
