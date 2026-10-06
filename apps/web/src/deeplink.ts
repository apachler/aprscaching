// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The addresses that open the platform rather than the landing. Kept apart from nav.ts so the thin App gate reads
 * them without pulling in the platform's modules.
 */

/**
 * The cache a share link names (`/?cache=AC-0001`: the Copy link, the printed QR, the embed's button, the feeds
 * and the sysop's reports all make this one form), upper-cased, or null when there is none or it is not a code.
 */
export function cacheFromQuery(search: string): string | null {
  const c = new URLSearchParams(search).get("cache")?.trim().toUpperCase();
  return c && /^[A-Z0-9][A-Z0-9-]{1,31}$/.test(c) ? c : null;
}

/**
 * Does the address open the platform itself — a view, a shared map view or a shared cache? Such a link is a
 * visit to the map, signed in or not, so the landing steps aside: a visitor who scanned a cache's QR sees the
 * cache, not the marketing page.
 */
export function opensPlatform(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.has("view") || q.has("v") || cacheFromQuery(search) != null;
}
