// SPDX-License-Identifier: MIT
/**
 * mice.ts — MIC-E decode and encode (APRS 1.2 chapter 10, "Mic-E Data Format").
 * MIC-E packs latitude + message bits into the AX.25 *destination* address, and
 * longitude + speed + course + symbol into the information field. Implemented from the
 * published algorithm (not derived from any third-party source).
 *
 * Destination char encoding (per position):
 *   '0'-'9' -> digit, sign bits 0 (South / +0 / East)
 *   'A'-'J' -> digit 0-9, custom message bit (1C); sign bits "don't care"
 *   'K','L','Z' -> position ambiguity (space)
 *   'P'-'Y' -> digit 0-9, sign bits 1 (North / +100 / West)
 * 'A'-'K' carry only message bits, so they appear in the first three characters alone.
 */
import { isValidLatLon } from "./geo.js";
import type { MicEDeviceCode } from "./types.js";
import { addMinutes, extractDao } from "./dao.js";
import { readLocator, type Locator } from "./locator.js";
import { rfClip } from "./text.js";

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
  /** The device code around the status text, when it leads with one (see {@link MicEDeviceCode}). */
  device?: MicEDeviceCode;
  /** The datum a `!DAO!` token in the status text names. */
  datum?: string;
  /** A Maidenhead locator leading the status text (`IO91SX/G Hello`); the Mic-E position stays the fix. */
  locator?: Locator;
}

// standard message table, indexed by the 3 message bits (A,B,C) read as a 3-bit number
const STD_MSG = ["Emergency", "Priority", "Special", "Committed", "Returning", "In Service", "En Route", "Off Duty"];
const CUSTOM_MSG = ["Emergency", "Custom-6", "Custom-5", "Custom-4", "Custom-3", "Custom-2", "Custom-1", "Custom-0"];
/** The message type when the three message bits mix Standard 1s and Custom 1s. */
const UNKNOWN_MSG = "Unknown";

function decodeDest(dest: string): {
  digits: number[];
  mbits: number[];
  custom: boolean;
  mixed: boolean;
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
    standard = false,
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
      // mbit stays 0 (the declaration default) for the 0–9 digit case.
    } else if (c >= "A" && c <= "K") {
      if (i >= 3) return null; // a message-bit-only character where a sign bit belongs
      if (c === "K") space = true;
      else digit = c.charCodeAt(0) - 65;
      mbit = 1;
      custom = true;
    } else if (c === "L") {
      space = true;
      mbit = 0;
    } else if (c >= "P" && c <= "Y") {
      digit = c.charCodeAt(0) - 80;
      mbit = 1;
      high = true;
      if (i < 3) standard = true;
    } else if (c === "Z") {
      space = true;
      mbit = 1;
      high = true;
      if (i < 3) standard = true;
    } else return null;
    if (space) ambiguity++;
    digits.push(digit);
    mbits.push(mbit);
    if (i === 3) north = high;
    if (i === 4) lonOffset = high;
    if (i === 5) west = high;
  }
  return { digits, mbits, custom, mixed: custom && standard, north, lonOffset, west, ambiguity };
}

/**
 * Decode a MIC-E frame from its destination address + information field. null when the minutes reach 60
 * or the position falls outside ±90° / ±180°.
 */
export function decodeMicE(dest: string, info: string): MicEFix | null {
  const dd = decodeDest(dest);
  if (!dd || info.length < 9) return null;
  const [d0, d1, d2, d3, d4, d5] = dd.digits as [number, number, number, number, number, number];

  // latitude DDMM.hh from the 6 destination digits
  const latDeg = d0 * 10 + d1;
  const latMin = d2 * 10 + d3 + (d4 * 10 + d5) / 100;
  if (latMin >= 60) return null;
  let lat = latDeg + latMin / 60;
  if (!dd.north) lat = -lat;

  // longitude from info bytes 1..3 (byte 0 is the MIC-E type id)
  let lonDeg = info.charCodeAt(1) - 28;
  if (dd.lonOffset) lonDeg += 100;
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
  let lonMin = info.charCodeAt(2) - 28;
  if (lonMin >= 60) lonMin -= 60;
  let lonHund = info.charCodeAt(3) - 28;
  if (lonDeg < 0 || lonMin < 0 || lonHund < 0 || lonHund > 99 || lonMin + lonHund / 100 >= 60) return null;
  // the latitude's ambiguity applies to the longitude: its last digits are dropped the same way
  if (dd.ambiguity >= 1) lonHund -= lonHund % 10;
  if (dd.ambiguity >= 2) lonHund = 0;
  if (dd.ambiguity >= 3) lonMin -= lonMin % 10;
  if (dd.ambiguity >= 4) lonMin = 0;
  let lon = lonDeg + (lonMin + lonHund / 100) / 60;
  if (dd.west) lon = -lon;
  if (!isValidLatLon(lat, lon)) return null;

  // speed (knots) + course (deg) from info bytes 4..6, each 0x1c–0x7f on the wire. A byte outside that
  // range carries no speed or course, and a course past 360° is not a heading.
  const sp = info.charCodeAt(4) - 28,
    dc = info.charCodeAt(5) - 28,
    se = info.charCodeAt(6) - 28;
  let speedKn: number | undefined, course: number | undefined;
  if ([sp, dc, se].every((v) => v >= 0 && v <= 99)) {
    speedKn = sp * 10 + Math.floor(dc / 10);
    course = (dc % 10) * 100 + se;
    if (speedKn >= 800) speedKn -= 800;
    if (course >= 400) course -= 400;
    // 0 is an unknown course and 360 due north; past 360 is not a heading
    if (course === 0 || course > 360) course = undefined;
  }

  const code = info[7] ?? "/";
  const table = info[8] ?? "/";

  const msgNum = (dd.mbits[0]! << 2) | (dd.mbits[1]! << 1) | dd.mbits[2]!;
  const messageType = dd.mixed ? UNKNOWN_MSG : (dd.custom ? CUSTOM_MSG : STD_MSG)[msgNum]!;

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

  const text = statusText(info.slice(9));
  if (text.altitudeM !== undefined) fix.altitudeM = text.altitudeM;
  let comment = text.comment ?? "";
  const dao = extractDao(comment);
  if (dao) {
    fix.datum = dao.datum;
    comment = dao.comment.trim();
    // An ambiguous position left digits out on purpose: added precision would contradict it.
    if (!dd.ambiguity) {
      const daoLat = addMinutes(lat, !dd.north, dao.latMin),
        daoLon = addMinutes(lon, dd.west, dao.lonMin);
      if (isValidLatLon(daoLat, daoLon)) {
        fix.lat = round(daoLat);
        fix.lon = round(daoLon);
      }
    }
  }
  const loc = readLocator(comment);
  if (loc) {
    fix.locator = loc.locator;
    comment = loc.text;
  }
  if (comment) fix.comment = comment;
  if (text.device) fix.device = text.device;
  return fix;
}

/**
 * A device code after a `` ` `` or `'` prefix: two characters, the first naming the maker's code range (`_` Yaesu,
 * `|` Byonics, `(` Anytone, `^`, `*`, `:` and `[` other makers), the second the model. The rule is the code's
 * shape, not a list of models, so a model the device database adds later is stripped too. A code led by a space
 * stays in the comment: a comment ending in a word of one character has the same shape.
 */
const MICE_CODE = /[_|(^*:[].$/;

/**
 * The Mic-E status text: an optional device prefix (`>` `]` for Kenwood, `` ` `` `'` for other makers), then
 * an optional altitude "xxx}" (base-91 metres above a datum 10 km below sea level), then the comment, then
 * the device's suffix (one character after a Kenwood prefix, two after the others). Prefix and suffix name
 * the radio and are not part of the comment.
 */
function statusText(rest: string): { altitudeM?: number; comment?: string; device?: MicEDeviceCode } {
  const prefix = /^[>\]`']/.test(rest) ? rest[0]! : "";
  let text = rest.slice(prefix.length);
  let altitudeM: number | undefined;
  const alt = /^([!-{])([!-{])([!-{])\}/.exec(text);
  if (alt) {
    const v = (alt[1]!.charCodeAt(0) - 33) * 8281 + (alt[2]!.charCodeAt(0) - 33) * 91 + (alt[3]!.charCodeAt(0) - 33);
    altitudeM = v - 10000;
    text = text.slice(4);
  }
  // the device code's raw tail, taken before the comment is stripped and trimmed (a suffix may be a space)
  const tail = prefix === ">" || prefix === "]" ? 1 : 2;
  const device = prefix ? { prefix, suffix: text.length >= tail ? text.slice(-tail) : "" } : undefined;
  if (prefix === ">") text = text.replace(/[=^&]$/, "");
  else if (prefix === "]") text = text.replace(/=$/, "");
  else if (prefix) text = text.replace(MICE_CODE, "");
  const comment = text.trim();
  return {
    ...(altitudeM !== undefined ? { altitudeM } : {}),
    ...(comment ? { comment } : {}),
    ...(device ? { device } : {}),
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** The standard Mic-E messages an encoder sends. Emergency is left out: no beacon raises one by default or by slip. */
export type MicEMessage = "Off Duty" | "En Route" | "In Service" | "Returning" | "Committed" | "Special" | "Priority";

export interface MicEEncodeOpts {
  /** Two characters, table then code (default `/>`, a car). */
  symbol?: string;
  speedKn?: number;
  /** Degrees, 1–360; 0 or none is an unknown course. */
  course?: number;
  altitudeM?: number;
  /** The status text, cut to fit the 43 bytes it shares with the altitude. */
  comment?: string;
  /** The standard message the destination carries (default `En Route`). */
  message?: MicEMessage;
}

/**
 * A Mic-E position (APRS 1.2 chapter 10): the destination address that carries the latitude and the message
 * bits, and the info field that carries the longitude, speed, course, symbol and an optional altitude and status
 * text. Nine bytes plus the status text against the nineteen of an uncompressed position, which counts on a
 * 300-baud HF channel. Speed and course take the offset forms (`+800` knots below 200 knots, `+400` degrees) so
 * neither byte is a control character; the longitude's hundredths and the course's last two digits may still be
 * one, as the format allows. {@link decodeMicE} reads back what this writes.
 */
export function encodeMicE(lat: number, lon: number, opts: MicEEncodeOpts = {}): { dest: string; info: string } {
  if (!isValidLatLon(lat, lon)) throw new RangeError("encodeMicE: latitude or longitude out of range");
  const [latDeg, latHund] = degHundredths(Math.abs(lat));
  // the longitude byte reaches 179°; 180° itself goes out as the nearest position it holds
  const [lonDeg, lonHund] = Math.abs(lon) >= 179.99992 ? [179, 5999] : degHundredths(Math.abs(lon));
  const latDigits = `${String(latDeg).padStart(2, "0")}${String(latHund).padStart(4, "0")}`;
  const msgIndex = Math.max(1, STD_MSG.indexOf(opts.message ?? "En Route"));
  const lonOffset = lonDeg < 10 || lonDeg >= 100;
  const high = [(msgIndex >> 2) & 1, (msgIndex >> 1) & 1, msgIndex & 1, lat >= 0, lonOffset, lon < 0];
  let dest = "";
  for (let i = 0; i < 6; i++) dest += String.fromCharCode((high[i] ? 80 : 48) + latDigits.charCodeAt(i) - 48);

  const degByte = lonDeg < 10 ? lonDeg + 90 : lonDeg < 100 ? lonDeg : lonDeg < 110 ? lonDeg - 20 : lonDeg - 100;
  const min = Math.floor(lonHund / 100),
    hund = lonHund % 100;
  const speed = Math.max(0, Math.min(799, Math.round(opts.speedKn ?? 0)));
  const course = opts.course && opts.course > 0 && opts.course <= 360 ? Math.round(opts.course) : 0;
  const tens = Math.floor(speed / 10);
  const ch = (v: number) => String.fromCharCode(v + 28);
  const sym = /^[\x21-\x7e]{2}$/.test(opts.symbol ?? "") ? opts.symbol! : "/>";
  let info =
    "`" +
    ch(degByte) +
    ch(min < 10 ? min + 60 : min) +
    ch(hund) +
    ch(tens < 20 ? tens + 80 : tens) +
    ch((speed % 10) * 10 + Math.floor(course / 100) + 4) +
    ch(course % 100) +
    sym[1]! +
    sym[0]!;
  let room = 43;
  if (opts.altitudeM !== undefined) {
    const v = Math.max(0, Math.min(91 ** 3 - 1, Math.round(opts.altitudeM) + 10000));
    info += String.fromCharCode(33 + Math.floor(v / 8281), 33 + (Math.floor(v / 91) % 91), 33 + (v % 91)) + "}";
    room -= 4;
  }
  let comment = (opts.comment ?? "").replace(/[\r\n\x00-\x1f\x7f]/g, "").trim();
  // a status text that opens with a device prefix would read as one; a space keeps it text
  if (/^[>\]`']/.test(comment)) comment = ` ${comment}`;
  info += rfClip(comment, room);
  return { dest, info };
}

/** Whole degrees and hundredths of a minute (0–5999), rounded, with a `60.00` minute carried into the degrees. */
function degHundredths(v: number): [number, number] {
  let d = Math.floor(v);
  let h = Math.round((v - d) * 6000);
  if (h >= 6000) {
    d += 1;
    h -= 6000;
  }
  return [d, h];
}
