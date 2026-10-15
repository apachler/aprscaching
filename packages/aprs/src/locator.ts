// SPDX-License-Identifier: MIT
/**
 * locator.ts — a Maidenhead locator leading a status report or Mic-E status text (APRS 1.2 chapters 10 and 16):
 * a 4- or 6-character locator, then a symbol table and code, then nothing or a space and the text
 * (`IO91SX/G`, `IO91/-`, `IO91SX/- My house`). Letters are sent in uppercase and read in either case.
 */
import { fromMaidenhead } from "./geo.js";

/** A Maidenhead locator and the centre of its cell: a coarse place, never a position fix. */
export interface Locator {
  /** The locator in uppercase, 4 or 6 characters (`IO91SX`). */
  grid: string;
  /** The cell's centre. A 6-character subsquare spans about 6 × 4.6 km, a 4-character square 2° × 1°. */
  lat: number;
  lon: number;
}

/**
 * The locator, then the symbol table (`/`, `\` or an overlay) and code, then the end or a space. The greedy
 * subsquare is tried first; every part is a fixed width, so the match is linear.
 */
const LOCATOR_RE = /^([A-Ra-r]{2}\d{2}(?:[A-Xa-x]{2})?)([/\\0-9A-Z])([!-~])(?: |$)/;

/** A locator leading `text` with its symbol and the text after it, or null when the text does not lead with one. */
export function readLocator(text: string): { locator: Locator; table: string; code: string; text: string } | null {
  const m = LOCATOR_RE.exec(text);
  if (!m) return null;
  const grid = m[1]!.toUpperCase();
  const centre = fromMaidenhead(grid);
  if (!centre) return null;
  return { locator: { grid, ...centre }, table: m[2]!, code: m[3]!, text: text.slice(m[0].length).trim() };
}
