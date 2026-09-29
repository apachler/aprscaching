// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// Helpers shared by the register parsers. A parser yields rows of exactly three fields — callsign,
// status, expiry — and nothing else from the source file.

/**
 * @typedef {{ callsign: string, status: "licensed" | "expired", expiresAt: number | null }} LicenceRow
 */

/** Unix seconds at the last second (UTC) of a calendar day — a licence is valid through its expiry date. */
export function endOfDayUtc(/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ d) {
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return Date.UTC(y, m - 1, d) / 1000 + 86399;
}

/** A register callsign: letters and digits, at least one of each, 3–12 characters. */
export const REGISTER_CALL = /^(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,12}$/;

/** "licensed" unless the expiry has passed. */
export const byExpiry = (/** @type {number | null} */ expiresAt, nowS = Math.floor(Date.now() / 1000)) =>
  expiresAt != null && expiresAt < nowS ? "expired" : "licensed";

/**
 * Split CSV text lines into records (RFC 4180 quoting: `"a, b"`, `""` escapes, quoted line breaks).
 * @param {AsyncIterable<string>} lines @returns {AsyncIterable<string[]>}
 */
export async function* csvRecords(lines) {
  let pending = "";
  for await (const line of lines) {
    const text = pending ? pending + "\n" + line : line;
    if ((text.match(/"/g)?.length ?? 0) % 2 === 1) {
      pending = text;
      continue;
    }
    pending = "";
    /** @type {string[]} */
    const out = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    yield out;
  }
}
