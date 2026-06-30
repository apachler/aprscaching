/**
 * encode.ts — minimal APRS info-string encoders for ORIGINATING traffic (APRS101). The decoder is
 * the bulk of this package; these let a licensed operator beacon a position or send a message
 * (docs/16 H5 gated browser TX). Pure + runtime-neutral; pair with encodeAx25 + kissWrap to frame.
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
