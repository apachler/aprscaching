// SPDX-License-Identifier: MIT
/**
 * trim.ts — trailing-run trimming by predicate. A `replace(/[…]+$/, "")` rescans the run from every
 * start position when the run is followed by other text, which is quadratic on a crafted line; this
 * walks back from the end once.
 */

/** `s` without its trailing run of characters for which `drop` holds. */
export function trimEndWhere(s: string, drop: (c: string) => boolean): string {
  let end = s.length;
  while (end > 0 && drop(s[end - 1]!)) end--;
  return end === s.length ? s : s.slice(0, end);
}
