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

/**
 * The callsign a join link names (`/join?call=OE8APR`, the form on the landing page and on the project's own sites),
 * upper-cased; `""` for a join link without a usable call, and null for any other address. The sign-in panel opens
 * on that call, so a visitor who typed it elsewhere does not type it again.
 */
export function joinCall(pathname: string, search: string): string | null {
  if (pathname.replace(/\/+$/, "") !== "/join") return null;
  const c = new URLSearchParams(search).get("call")?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}$/.test(c) ? c : "";
}

export type TourName = "game" | "shack";

/** The public tour an address opens (`/tour/game`, `/tour/shack`), or null. */
export function tourFromPath(pathname: string): TourName | null {
  const m = /^\/tour\/(game|shack)\/?$/.exec(pathname);
  return m ? (m[1] as TourName) : null;
}
