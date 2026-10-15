// SPDX-License-Identifier: MIT
/**
 * dao.ts — the `!DAO!` precision and datum option (APRS 1.2, "APRS Precision and Datum Option").
 *
 * Five characters anywhere in a position comment, best at its end: `!`, the datum D, one added digit of
 * latitude minutes A, one of longitude minutes O, `!`. The datum's case says how A and O are written:
 *   - uppercase (`!W23!`): human-readable digits, the third decimal of the minutes (about 2 m);
 *   - lowercase (`!w%^!`): base-91 characters (`!` is 0 … `{` is 90), the third and fourth decimals together,
 *     read as round(v / 91 · 100) ten-thousandths of a minute (about 0.2 m);
 *   - a space for A or O adds no precision: the token then only names the datum.
 * D is a letter for one of the common datums (`W` WGS84, `N` NAD27, `O` OSGB36) or a digit for a local one; a
 * digit datum says nothing of the format, so it adds no precision.
 */

/** A `!DAO!` token read out of a comment. */
export interface Dao {
  /** The datum character, uppercased for a letter (`W` is WGS84). */
  datum: string;
  /** Minutes to add to the latitude's magnitude, 0 – 0.0099. */
  latMin: number;
  /** Minutes to add to the longitude's magnitude, 0 – 0.0099. */
  lonMin: number;
  /** The comment without the token. */
  comment: string;
}

/** A token's shape; the characters are checked against the datum's case after the match. */
const DAO_RE = /!([0-9A-Za-z])([ -{])([ -{])!/g;

/** One added digit: a human-readable digit, a base-91 character, or a space for none. null when not valid. */
function extraMinutes(c: string, form: "digit" | "base91" | "none"): number | null {
  if (c === " " || form === "none") return 0;
  if (form === "digit") return c >= "0" && c <= "9" ? Number(c) / 1000 : null;
  return Math.round(((c.charCodeAt(0) - 33) / 91) * 100) / 10000;
}

/**
 * The last valid `!DAO!` token in a comment and the comment without it, or null when it holds none. The last
 * one wins: the spec asks for the token at the end, after any comment text and Base91 telemetry.
 */
export function extractDao(comment: string): Dao | null {
  let found: { index: number; datum: string; latMin: number; lonMin: number } | null = null;
  for (const m of comment.matchAll(DAO_RE)) {
    const d = m[1]!;
    const form = d >= "A" && d <= "Z" ? "digit" : d >= "a" && d <= "z" ? "base91" : "none";
    const latMin = extraMinutes(m[2]!, form),
      lonMin = extraMinutes(m[3]!, form);
    if (latMin === null || lonMin === null) continue;
    found = { index: m.index, datum: d.toUpperCase(), latMin, lonMin };
  }
  if (!found) return null;
  const { index, ...dao } = found;
  return { ...dao, comment: comment.slice(0, index) + comment.slice(index + 5) };
}

/** A coordinate with `minutes` added to its magnitude, so a southern or western one moves further from 0. */
export const addMinutes = (deg: number, negative: boolean, minutes: number): number =>
  (Math.abs(deg) + minutes / 60) * (negative ? -1 : 1);
