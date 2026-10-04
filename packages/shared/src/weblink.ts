// SPDX-License-Identifier: MIT
/**
 * A link to a web page taken from someone else's data (an imported cache's listing, a feed): the address as
 * given when it is an absolute http(s) URL, else null. Anything else (`javascript:`, `data:`, a relative path)
 * is never stored as a link nor rendered as one.
 */
export function webLink(u: unknown, maxLength = 2048): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim();
  if (!s || s.length > maxLength) return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? s : null;
  } catch {
    return null;
  }
}
