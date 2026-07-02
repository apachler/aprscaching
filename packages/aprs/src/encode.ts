// SPDX-License-Identifier: MIT
/**
 * encode.ts — minimal APRS info-string encoders for ORIGINATING traffic (APRS101). The decoder is
 * the bulk of this package; these let a licensed operator beacon a position or send a message
 * (docs/design/16 H5 gated browser TX). Pure + runtime-neutral; pair with encodeAx25 + kissWrap to frame.
 */

/** Degrees → APRS ddmm.mmH (lat: 2°+2'+.+2; lon: 3°+2'+.+2). */
function degMin(deg: number, isLat: boolean): string {
  const hemi = isLat ? (deg < 0 ? "S" : "N") : (deg < 0 ? "W" : "E");
  const v = Math.abs(deg);
  const d = Math.floor(v);
  const m = (v - d) * 60;
  const dd = String(d).padStart(isLat ? 2 : 3, "0");
  const mm = m.toFixed(2).padStart(5, "0");   // "MM.mm"
  return `${dd}${mm}${hemi}`;
}

/** Strip control chars APRS info fields must not carry (and trim). */
const clean = (s: string): string => s.replace(/[\r\n\x00-\x1f\x7f]/g, "").trim();

/**
 * Uncompressed APRS position report (no timestamp): `!lat/lon>comment`. `symbol` is a 2-char
 * table+code (default "/>" = car); comment is cleaned + length-capped.
 */
export function encodeAprsPosition(lat: number, lon: number, symbol = "/>", comment = ""): string {
  const table = symbol[0] ?? "/", code = symbol[1] ?? ">";
  return `!${degMin(lat, true)}${table}${degMin(lon, false)}${code}${clean(comment).slice(0, 43)}`;
}

/**
 * APRS text message: `:ADDRESSEE :text{msgNo` (addressee space-padded to 9). The message text may not
 * contain `|`, `~` or `{` (reserved); they're stripped. Returns the info string only.
 */
export function encodeAprsMessage(addressee: string, text: string, msgNo?: string): string {
  const to = clean(addressee).toUpperCase().slice(0, 9).padEnd(9, " ");
  const body = clean(text).replace(/[|~{]/g, "").slice(0, 67);
  return `:${to}:${body}${msgNo ? `{${msgNo.slice(0, 5)}` : ""}`;
}

/** Metric weather fields for a WX beacon (docs/design/17 W2/W3). All optional; missing → APRS placeholders. */
export interface WxEncodeFields {
  tempC?: number; humidity?: number; pressureHpa?: number;
  windDirDeg?: number; windKn?: number; gustKn?: number;
  rainMm?: number; rain24hMm?: number; rainMidMm?: number; luminosityWm2?: number;
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
  if (wx.humidity != null) { const h = Math.round(wx.humidity); s += `h${String(h >= 100 ? 0 : Math.max(0, h)).padStart(2, "0")}`; }
  if (wx.pressureHpa != null) s += `b${String(Math.max(0, Math.min(99999, Math.round(wx.pressureHpa * 10)))).padStart(5, "0")}`;
  if (wx.luminosityWm2 != null) { const l = Math.max(0, Math.round(wx.luminosityWm2)); s += l < 1000 ? `L${wx3(l)}` : `l${wx3(l - 1000)}`; }
  return s;
}
