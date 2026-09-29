// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `s` without its trailing run of any of `chars`. Walks back from the end once: a `/x+$/` replace
 * rescans the run from every start position when text follows it, which is quadratic on a crafted value.
 */
export function trimEndChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return end === s.length ? s : s.slice(0, end);
}
