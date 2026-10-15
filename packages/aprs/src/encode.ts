// SPDX-License-Identifier: MIT
/**
 * encode.ts — minimal APRS info-string encoders for ORIGINATING traffic (APRS101). The decoder is
 * the bulk of this package; these let a licensed operator beacon a position or send a message.
 * Pure + runtime-neutral. They return text: its length limits count the UTF-8 bytes it goes out as, and
 * `rfBytes` turns it into those bytes for encodeAx25 + kissWrap.
 */
import { rfClip } from "./text.js";

/** Degrees → APRS ddmm.mmH (lat: 2°+2'+.+2; lon: 3°+2'+.+2). */
function degMin(deg: number, isLat: boolean): string {
  const hemi = isLat ? (deg < 0 ? "S" : "N") : deg < 0 ? "W" : "E";
  const v = Math.abs(deg);
  let d = Math.floor(v);
  // Round the whole minutes value to hundredths as an integer and carry a `60.00`
  // overflow into the degrees — `m.toFixed(2)` alone yields e.g. `0460.00N`, which strict
  // APRS-IS / CWOP / NOAA parsers reject.
  let cm = Math.round((v - d) * 60 * 100); // hundredth-minutes
  if (cm >= 6000) {
    d += 1;
    cm -= 6000;
  }
  const dd = String(d).padStart(isLat ? 2 : 3, "0");
  const mm = (cm / 100).toFixed(2).padStart(5, "0"); // "MM.mm"
  return `${dd}${mm}${hemi}`;
}

/** Strip control chars APRS info fields must not carry (and trim). */
const clean = (s: string): string => s.replace(/[\r\n\x00-\x1f\x7f]/g, "").trim();

/** An APRS symbol: exactly two printable ASCII characters (0x21–0x7E), table then code. */
export const isAprsSymbol = (s: string): boolean => /^[\x21-\x7e]{2}$/.test(s);

/**
 * Uncompressed APRS position report (no timestamp): `!lat/lon>comment`. `symbol` is a 2-char
 * table+code (default "/>" = car; anything that is not `isAprsSymbol` falls back to it); comment is
 * cleaned + capped at 43 bytes of UTF-8.
 */
export function encodeAprsPosition(lat: number, lon: number, symbol = "/>", comment = ""): string {
  const sym = isAprsSymbol(symbol) ? symbol : "/>";
  const table = sym[0]!,
    code = sym[1]!;
  return `!${degMin(lat, true)}${table}${degMin(lon, false)}${code}${rfClip(clean(comment), 43)}`;
}

/** Four base-91 digits (APRS101 §9), most significant first. */
function base91(n: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out = String.fromCharCode(33 + (n % 91)) + out;
    n = Math.floor(n / 91);
  }
  return out;
}

/**
 * Compressed position without course, speed or altitude (APRS101 §9): `TYYYYXXXXC  !`. Thirteen characters
 * against nineteen for `ddmm.mmN/dddmm.mmE`, and finer than the hundredths of a minute those carry. The space in
 * the `c` column says the `csT` bytes carry nothing. A digit overlay goes out as `a`–`j`.
 */
function compressedPosition(lat: number, lon: number, table: string, code: string): string {
  const la = Math.max(-90, Math.min(90, lat));
  const lo = Math.max(-180, Math.min(180, lon));
  const y = Math.min(91 ** 4 - 1, Math.round(380926 * (90 - la)));
  const x = Math.min(91 ** 4 - 1, Math.round(190463 * (180 + lo)));
  const t = /^[0-9]$/.test(table) ? String.fromCharCode(97 + Number(table)) : table;
  return `${t}${base91(y)}${base91(x)}${code}  !`;
}

/** An object name: one to nine printable ASCII characters, with no leading or trailing space. */
export const isAprsObjectName = (s: string): boolean => /^[\x21-\x7e](?:[\x20-\x7e]{0,7}[\x21-\x7e])?$/.test(s);

/** What `encodeAprsObject` sends. */
export interface AprsObjectFields {
  /** One to nine printable ASCII characters (`isAprsObjectName`); padded to nine on air. */
  name: string;
  lat: number;
  lon: number;
  /** Table and code (`isAprsSymbol`); anything else falls back to the point of interest, `\i`. */
  symbol?: string;
  comment?: string;
  /** false sends the object killed (`_`), which takes it off the maps and radios that show it. Default true. */
  alive?: boolean;
  /** The object's time, sent as DDHHMM zulu. Default now. */
  at?: Date;
}

/**
 * APRS object (APRS101 §11): `;NAME_____*DDHHMMz` + compressed position + comment. `*` is a live object, `_` a
 * killed one. The position is compressed, the shorter form on air. The comment is cleaned and capped at 43 bytes
 * of UTF-8. Throws on a name `isAprsObjectName` refuses, since a clipped name would address another object.
 */
export function encodeAprsObject(o: AprsObjectFields): string {
  if (!isAprsObjectName(o.name)) throw new RangeError("an object name is 1-9 printable ASCII characters");
  const sym = o.symbol && isAprsSymbol(o.symbol) ? o.symbol : "\\i";
  const at = o.at ?? new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}z`;
  const pos = compressedPosition(o.lat, o.lon, sym[0]!, sym[1]!);
  const mark = o.alive === false ? "_" : "*";
  return `;${o.name.padEnd(9, " ")}${mark}${stamp}${pos}${rfClip(clean(o.comment ?? ""), 43)}`;
}

/**
 * APRS text message: `:ADDRESSEE :text{msgNo` (addressee space-padded to 9). The message text may not
 * contain `|`, `~` or `{` (reserved); they're stripped, and it is capped at 67 bytes of UTF-8, cut between
 * characters. Returns the info string only.
 */
export function encodeAprsMessage(addressee: string, text: string, msgNo?: string): string {
  const to = clean(addressee).toUpperCase().slice(0, 9).padEnd(9, " ");
  const body = rfClip(clean(text).replace(/[|~{]/g, ""), 67);
  return `:${to}:${body}${msgNo ? `{${msgNo.slice(0, 5)}` : ""}`;
}

/** Metric weather fields for a WX beacon. All optional; missing → APRS placeholders. */
export interface WxEncodeFields {
  tempC?: number;
  humidity?: number;
  pressureHpa?: number;
  windDirDeg?: number;
  windKn?: number;
  gustKn?: number;
  rainMm?: number;
  rain24hMm?: number;
  rainMidMm?: number;
  luminosityWm2?: number;
}

const KN_TO_MPH = 1.15078;
const MM_PER_HUNDREDTH_INCH = 0.254;
/** 0–999, 3-digit zero-padded; unknown → "..." (APRS placeholder for the required wind/gust fields). */
function wx3(n: number | undefined): string {
  return n == null || !Number.isFinite(n) ? "..." : String(Math.max(0, Math.min(999, Math.round(n)))).padStart(3, "0");
}
/** Temperature in °F as the 3-char APRS field (negatives as "-NN"); unknown → "...". */
function wxTempF(c: number | undefined): string {
  if (c == null || !Number.isFinite(c)) return "...";
  const f = Math.max(-99, Math.min(999, Math.round((c * 9) / 5 + 32)));
  return f < 0 ? `-${String(-f).padStart(2, "0")}` : String(f).padStart(3, "0");
}

/**
 * APRS complete weather report at a fixed position, no timestamp (APRS101 §12):
 *   `!ddmm.mmN/dddmm.mmE_CCC/SSSgGGGtTTTrRRRpPPPPPPhHHbBBBBB`
 * Units are the APRS wire units (mph / °F / 0.01 in / 0.1 hPa) so the beacon is correct for real
 * APRS-IS / CWOP / NOAA consumers — NOT our internal metric. Wind dir/speed/gust/temp are always
 * present (placeholders when unknown); rain/humidity/pressure/luminosity only when known.
 */
export function encodeAprsWeather(lat: number, lon: number, wx: WxEncodeFields): string {
  const dir = wx3(wx.windDirDeg);
  const spd = wx3(wx.windKn != null ? wx.windKn * KN_TO_MPH : undefined);
  let s = `!${degMin(lat, true)}/${degMin(lon, false)}_${dir}/${spd}`;
  s += `g${wx3(wx.gustKn != null ? wx.gustKn * KN_TO_MPH : undefined)}`;
  s += `t${wxTempF(wx.tempC)}`;
  if (wx.rainMm != null) s += `r${wx3(wx.rainMm / MM_PER_HUNDREDTH_INCH)}`;
  if (wx.rain24hMm != null) s += `p${wx3(wx.rain24hMm / MM_PER_HUNDREDTH_INCH)}`;
  if (wx.rainMidMm != null) s += `P${wx3(wx.rainMidMm / MM_PER_HUNDREDTH_INCH)}`;
  if (wx.humidity != null) {
    const h = Math.round(wx.humidity);
    s += `h${String(h >= 100 ? 0 : Math.max(0, h)).padStart(2, "0")}`;
  }
  if (wx.pressureHpa != null)
    s += `b${String(Math.max(0, Math.min(99999, Math.round(wx.pressureHpa * 10)))).padStart(5, "0")}`;
  if (wx.luminosityWm2 != null) {
    const l = Math.max(0, Math.round(wx.luminosityWm2));
    s += l < 1000 ? `L${wx3(l)}` : `l${wx3(l - 1000)}`;
  }
  return s;
}
