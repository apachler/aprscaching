// SPDX-License-Identifier: MIT
/**
 * decode.ts — top-level APRS payload decoder (APRS101). Dispatches on the data-type identifier
 * (first payload byte) to produce a typed `AprsData`. Builds on parsePosition (uncompressed),
 * parseCompressed (base-91), decodeMicE, plus object/item/message/status/weather/telemetry.
 */
import type { ParsedFrame, AprsData, DecodedPosition, DecodedWeather } from "./types.js";
import { lookupSymbol } from "./symbols.js";
import { parseCompressed } from "./compressed.js";
import { decodeMicE } from "./mice.js";
import { isValidLatLon } from "./geo.js";

const UNCOMP_RE = /^(\d{2})([0-7 ][0-9 ]\.[0-9 ]{2})([NS])(.)(\d{3})([0-7 ][0-9 ]\.[0-9 ]{2})([EW])(.)/;

/**
 * Parse an uncompressed "DDMM.hhN/DDDMM.hhW$" head; returns the fix + the comment remainder, or null when
 * the minutes reach 60 or the position falls outside ±90° / ±180°.
 */
function parseUncompressed(s: string): { fix: DecodedPosition; rest: string } | null {
  const m = UNCOMP_RE.exec(s);
  if (!m) return null;
  const [whole, latDeg, latMin, ns, table, lonDeg, lonMin, ew, code] = m;
  const ambiguity = (latMin!.match(/ /g)?.length ?? 0) + (lonMin!.match(/ /g)?.length ?? 0);
  const latMinNum = Number(latMin!.replace(/ /g, "0"));
  const lonMinNum = Number(lonMin!.replace(/ /g, "0"));
  if (!(latMinNum < 60 && lonMinNum < 60)) return null;
  let lat = Number(latDeg) + latMinNum / 60;
  let lon = Number(lonDeg) + lonMinNum / 60;
  if (ns === "S") lat = -lat;
  if (ew === "W") lon = -lon;
  if (!isValidLatLon(lat, lon)) return null;
  const fix: DecodedPosition = { lat: round(lat), lon: round(lon), symbol: lookupSymbol(table!, code!), ambiguity };
  return { fix, rest: s.slice(whole.length) };
}

/** Course/speed "CSE/SPD", altitude "/A=dddddd", and PHG out of a comment string. */
function applyExtensions(fix: DecodedPosition, comment: string): void {
  const cs = /^(\d{3})\/(\d{3})/.exec(comment);
  if (cs) {
    if (Number(cs[1]) <= 360) fix.course = Number(cs[1]); // three digits past 360 are not a heading
    fix.speedKn = Number(cs[2]);
    comment = comment.slice(7);
  }
  const alt = /\/A=(-\d{5,6}|\d{6})/.exec(comment); // six characters, a leading minus below sea level
  if (alt) {
    fix.altitudeM = Math.round(Number(alt[1]) * 0.3048);
    comment = comment.replace(alt[0], "");
  }
  const c = comment.trim();
  if (c) fix.comment = c;
}

/** Knots in one mph: APRS weather reports wind and gust in mph. */
const KN_PER_MPH = 0.868976;
/** The positioned weather head "DDD/SSS" (wind direction and speed), dots or spaces where unknown. */
const WX_HEAD = /^([\d. ]{3})\/([\d. ]{3})/;
/** The width of each weather field after its letter; the fields follow one another, then any comment. */
const WX_FIELDS: Record<string, number> = { c: 3, s: 3, g: 3, t: 3, r: 3, p: 3, P: 3, h: 2, b: 5, L: 3, l: 3, "#": 3 };

/**
 * The weather fields at the start of `s`, in order, each its letter and a fixed-width value; a value of
 * dots or spaces is unknown. The scan stops at the first character that starts no field, so letters in
 * the comment after the fields are never read as data. Returns the values that are numbers and how many
 * fields were read.
 */
function scanWeatherFields(s: string): { fields: Record<string, number>; count: number } {
  const fields: Record<string, number> = {};
  let i = 0,
    count = 0;
  while (i < s.length) {
    const w = WX_FIELDS[s[i]!];
    if (!w || i + 1 + w > s.length) break;
    const v = s.slice(i + 1, i + 1 + w);
    if (!/^(-?\d+|[. ]+)$/.test(v)) break;
    if (/^-?\d+$/.test(v)) fields[s[i]!] = Number(v);
    count++;
    i += 1 + w;
  }
  return { fields, count };
}

/** A three-digit wind direction (past 360 is not one) and a wind speed in mph, as degrees and knots. */
function setWind(wx: DecodedWeather, dir: number | undefined, mph: number | undefined): void {
  if (dir !== undefined && dir <= 360) wx.windDirDeg = dir;
  if (mph !== undefined) wx.windKn = round1(mph * KN_PER_MPH);
}

/**
 * Weather out of a report body: positioned ("DDD/SSS" then the fields), positionless ("c…s…" fields) or the
 * remainder of a compressed position, whose course and speed (knots) carry the wind.
 */
function parseWeather(s: string, compressedWind?: { dir?: number; kn?: number }): DecodedWeather {
  const wx: DecodedWeather = {};
  const head = WX_HEAD.exec(s);
  const digits = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  if (head) setWind(wx, digits(head[1]), digits(head[2]));
  const { fields: f } = scanWeatherFields(head ? s.slice(7) : s);
  if (!head) setWind(wx, f.c, f.s);
  if (compressedWind) {
    if (compressedWind.dir !== undefined) wx.windDirDeg = compressedWind.dir;
    if (compressedWind.kn !== undefined) wx.windKn = compressedWind.kn;
  }
  if (f.g !== undefined) wx.gustKn = round1(f.g * KN_PER_MPH);
  if (f.t !== undefined) wx.tempC = round1(((f.t - 32) * 5) / 9);
  if (f.r !== undefined) wx.rain1hMm = round(f.r * 0.254);
  if (f.p !== undefined) wx.rain24hMm = round(f.p * 0.254);
  if (f.P !== undefined) wx.rainMidnightMm = round(f.P * 0.254);
  if (f.h !== undefined) wx.humidity = f.h === 0 ? 100 : f.h;
  if (f.b !== undefined) wx.pressureHpa = round(f.b * 0.1);
  return wx;
}
/** A positioned weather report: the wind head after the symbol (any field unknown) and nothing else needed. */
const isWeather = (s: string) => WX_HEAD.test(s);
/** A compressed weather report: the fields follow the compressed position directly. */
const isCompressedWeather = (s: string) => scanWeatherFields(s).count > 0;

export function decodeAprs(frame: ParsedFrame): AprsData {
  const p = frame.payload;
  const t = p[0] ?? "";

  // MIC-E: type id is one of these and latitude lives in the destination
  if ((t === "`" || t === "'" || t === "\x1c" || t === "\x1d") && frame.dst) {
    const me = decodeMicE(frame.dst, p);
    if (me)
      return {
        kind: "position",
        lat: me.lat,
        lon: me.lon,
        symbol: lookupSymbol(me.table, me.code),
        course: me.course,
        speedKn: me.speedKn,
        altitudeM: me.altitudeM,
        comment: me.comment,
        ambiguity: me.ambiguity,
        messageType: me.messageType,
      };
  }

  switch (t) {
    case "!":
    case "=":
    case "@":
    case "/": {
      // strip a timestamp for @ and / (7 chars: DDHHMMz or HHMMSSh)
      let body = p.slice(1),
        timestamp: string | undefined;
      if (t === "@" || t === "/") {
        timestamp = body.slice(0, 7);
        body = body.slice(7);
      }
      return decodePosition(body, timestamp);
    }
    case ";":
      return decodeObject(p);
    case ")":
      return decodeItem(p);
    case ":":
      return decodeMessage(p);
    case ">":
      return { kind: "status", text: p.slice(1).trim() };
    case "_": {
      // positionless weather: _MMDDHHMM then the c…s… fields
      return { kind: "weather", ...parseWeather(p.slice(9)) };
    }
    case "T": {
      // telemetry: T#seq,a1,a2,a3,a4,a5,bbbbbbbb
      return decodeTelemetry(p);
    }
    default:
      return { kind: "other" };
  }
}

function decodePosition(body: string, timestamp?: string): AprsData {
  let fix: DecodedPosition | null = null,
    rest = "",
    compressed = false;
  const comp = parseCompressed(body);
  if (comp && isValidLatLon(comp.lat, comp.lon)) {
    compressed = true;
    fix = {
      lat: round(comp.lat),
      lon: round(comp.lon),
      symbol: lookupSymbol(comp.table, comp.code),
      course: comp.course,
      speedKn: comp.speedKn,
      altitudeM: comp.altitudeM,
    };
    rest = body.slice(13);
  } else {
    const u = parseUncompressed(body);
    if (u) {
      fix = u.fix;
      rest = u.rest;
    }
  }
  if (!fix) return { kind: "other" };
  if (timestamp) fix.timestamp = timestamp;
  // weather station (symbol '_') with wx after the position -> weather report
  if (fix.symbol?.code === "_") {
    const where = { lat: fix.lat, lon: fix.lon, symbol: fix.symbol, ...(timestamp ? { timestamp } : {}) };
    if (compressed && isCompressedWeather(rest))
      return { kind: "weather", ...where, ...parseWeather(rest, { dir: fix.course, kn: fix.speedKn }) };
    if (!compressed && isWeather(rest)) return { kind: "weather", ...where, ...parseWeather(rest) };
  }
  applyExtensions(fix, rest);
  return { kind: "position", ...fix };
}

// A non-position object/item (e.g. `;SHORT` with no fix) must NOT be spread with
// {lat:0,lon:0} — that plants a phantom station on null island. Return no coords unless a real
// position decoded; the object/item variants carry Partial<DecodedPosition> for exactly this. An object
// with the weather symbol keeps its position and its weather.
function posFields(pos: AprsData): Partial<DecodedPosition> & Partial<DecodedWeather> {
  if (pos.kind !== "position" && pos.kind !== "weather") return {};
  const { kind, ...fields } = pos;
  return fields;
}

/** An object or item timestamp: DDHHMM zulu or local (`z`, `/`), or HHMMSS (`h`). */
const STAMP = /^\d{6}[zh/]/;

function decodeObject(p: string): AprsData {
  // ;NAME_____*DDHHMMz<position>   ('*' alive, '_' killed; the name padded to 9 with trailing spaces)
  const mark = p[10];
  if (mark !== "*" && mark !== "_") return { kind: "other" };
  const name = p.slice(1, 10).trimEnd();
  // An object always carries a timestamp; one sent without it still decodes, rather than losing 7
  // characters of its position.
  const after = p.slice(11);
  const timestamp = STAMP.test(after) ? after.slice(0, 7) : undefined;
  const body = timestamp ? after.slice(7) : after;
  return {
    kind: "object",
    name,
    alive: mark === "*",
    ...posFields(decodePosition(body)),
    ...(timestamp ? { timestamp } : {}),
  };
}

function decodeItem(p: string): AprsData {
  // )NAME!<position>  or )NAME_<position>  (name 3-9 chars, '!' alive / '_' killed)
  const m = /^\)([^!_]{3,9})([!_])(.*)$/s.exec(p);
  if (!m) return { kind: "other" };
  return { kind: "item", name: m[1]!.trim(), alive: m[2] === "!", ...posFields(decodePosition(m[3]!)) };
}

function decodeMessage(p: string): AprsData {
  // :ADDRESSEE:text{msgNo   (addressee padded to 9)
  const m = /^:(.{9}):(.*)$/s.exec(p);
  if (!m) return { kind: "other" };
  const addressee = m[1]!.trim();
  const text = m[2]!;
  const out: AprsData = { kind: "message", addressee, text };
  if (/^ack/.test(text)) {
    out.ack = true;
    out.msgNo = text.slice(3).trim();
    out.text = "";
    return out;
  }
  if (/^rej/.test(text)) {
    out.rej = true;
    out.msgNo = text.slice(3).trim();
    out.text = "";
    return out;
  }
  // The message number follows the first '{' after the last '}' and runs to the end of the text.
  // An index scan keeps this linear on a crafted body of many braces.
  const brace = text.indexOf("{", text.lastIndexOf("}") + 1);
  if (brace >= 0 && brace < text.length - 1) {
    out.msgNo = text.slice(brace + 1);
    out.text = text.slice(0, brace);
  }
  if (/^(BLN|NWS|SKY)/.test(addressee)) out.bulletin = addressee;
  return out;
}

/** Line terminators: a telemetry report is one line, so a body carrying one is not decoded. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

function decodeTelemetry(p: string): AprsData {
  // T#<seq>,<a1>,…,<a5>,<bits> — an optional '#', an optional sequence number, an optional ',', then
  // the fields. Scanned by index (not one backtracking pattern) so a long digit run stays linear.
  const s = p.slice(1);
  if (LINE_BREAK.test(s)) return { kind: "telemetry", analog: [], digital: [] };
  let i = s[0] === "#" ? 1 : 0;
  const seqStart = i;
  while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
  // a digit run too long for an exact integer is no sequence number (and a value of `1e999` no reading)
  const seqNum = Number(s.slice(seqStart, i));
  const seq = i > seqStart && Number.isSafeInteger(seqNum) ? seqNum : undefined;
  if (s[i] === ",") i++;
  const parts = s.slice(i).split(",");
  const analog = parts
    .slice(0, 5)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const bits = parts[5] ?? "";
  const digital = /^[01]{1,8}$/.test(bits) ? [...bits].map((b) => b === "1") : [];
  return { kind: "telemetry", seq, analog, digital };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const round1 = (n: number) => Math.round(n * 10) / 10;
