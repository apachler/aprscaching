// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The hotspot origin of an off-grid station: a visitor's phone on the station's Wi-Fi hotspot reaches the
 * gateway at the Node server's own https listener (HTTPS_PORT), on one of the station's private IPv4
 * addresses. APP_URL stays the owner's origin (http://localhost, where passkeys work), which no other
 * device can open, so an operator sign-in link for a visitor names the hotspot origin instead, and the
 * visitor's confirm step returns there.
 *
 * The origin is recognised by its shape, not by asking the host for its interface addresses: https, an
 * RFC 1918 IPv4 literal, and exactly the port the running https listener binds. Interface enumeration is
 * not dependable on every host the Node server runs on (a phone's sandbox may refuse it), while the shape
 * already excludes every public or named origin; the station's certificate names only its current
 * addresses, so an origin at another private address fails TLS in the visitor's browser.
 */
import type { Env } from "./env.js";
import { bareWebOrigin } from "@aprscaching/shared";

/** 10/8, 172.16/12, 192.168/16 as a canonical dotted quad (the URL parser normalises other spellings). */
function rfc1918(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The hotspot origin `candidate` names — https, an RFC 1918 IPv4 host, the running https listener's port —
 * or null. Closed while no https listener runs (Bun never has one).
 */
export function hotspotOrigin(candidate: string, env: Env): string | null {
  const port = env.HTTPS_LISTENER_PORT;
  if (!port) return null;
  const u = bareWebOrigin(candidate);
  if (!u || u.protocol !== "https:" || (u.port || "443") !== port || !rfc1918(u.hostname)) return null;
  return u.origin;
}

/**
 * The origin an operator sign-in link may name when the minting call asks for one: an address of this instance
 * (APP_URL or an EXTRA_ORIGINS entry, passed in as `listed`), or this station's hotspot origin. Anything else is
 * null — the link never names an origin a caller made up.
 */
export function linkOrigin(candidate: string, env: Env, listed: readonly string[]): string | null {
  const u = bareWebOrigin(candidate);
  if (!u) return null;
  if (listed.includes(u.origin)) return u.origin;
  return hotspotOrigin(candidate, env);
}
