// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The addresses one instance answers on: its main origin (APP_URL) and the further ones in EXTRA_ORIGINS — a
 * 44Net name over https, a HAMNET name or address over plain http. Each request is answered for the address it
 * came on: its session cookie, the sign-in links it starts and the links into the app it builds name that
 * address, so a member on HAMNET stays on HAMNET. APP_URL stays the canonical address for what is
 * not tied to a request (the sitemap, the digest mail, the federation descriptor's identity).
 *
 * The request's address is read from its Host and, behind a declared proxy (TRUST_PROXY=1), the scheme the
 * TLS-terminating proxy reports, and is believed only when it is one of the configured addresses: a sign-in link built from a Host header anyone can send
 * would carry its token to that host. Any other host is answered as if the request came to APP_URL.
 */
import type { Env } from "./env.js";
import { parseOriginList } from "@aprscaching/shared";
import { hotspotOrigin } from "./visitor.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** APP_URL's origin, or null when it is unset or does not parse. */
export function mainOrigin(env: Env): string | null {
  const s = env.APP_URL?.trim();
  if (!s) return null;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/** The valid EXTRA_ORIGINS entries as origins, APP_URL's own left out. */
export function extraOrigins(env: Env): string[] {
  const main = mainOrigin(env);
  return parseOriginList(env.EXTRA_ORIGINS).origins.filter((o) => o !== main);
}

/** Every configured address of this instance: APP_URL first, then EXTRA_ORIGINS. */
export function instanceOrigins(env: Env): string[] {
  const main = mainOrigin(env);
  return [...(main ? [main] : []), ...extraOrigins(env)];
}

/** Is `origin` a secure context a browser offers passkeys and the other https-only features on? */
export function secureOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
  } catch {
    return false;
  }
}

/**
 * The origins a passkey ceremony may come from: every configured address that is a secure context. All of
 * them share the one relying party, RP_ID; those outside it are its related origins (/.well-known/webauthn).
 */
export function passkeyOrigins(env: Env): string[] {
  return instanceOrigins(env).filter(secureOrigin);
}

/**
 * The origin the request arrived on as the browser saw it: the listener's scheme, raised to https when a
 * TLS-terminating proxy says so (a header never lowers an https request), and the Host. The proxy's header
 * counts only with TRUST_PROXY=1: without a declared proxy anyone can send it, and a plain-http request
 * claiming https would get the https address's cookie and links.
 */
function arrivalOrigin(req: Request, env: Env): string | null {
  try {
    const u = new URL(req.url);
    const fwd =
      env.TRUST_PROXY === "1" ? req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() : undefined;
    const scheme = u.protocol === "https:" || fwd === "https" ? "https:" : "http:";
    return new URL(`${scheme}//${u.host}`).origin;
  } catch {
    return null;
  }
}

/**
 * The configured address this request came on — APP_URL, an EXTRA_ORIGINS entry, or the station's hotspot
 * origin (visitor.ts) — or null when it came on any other host.
 */
function listedRequestOrigin(req: Request, env: Env): string | null {
  const o = arrivalOrigin(req, env);
  if (!o) return null;
  if (instanceOrigins(env).includes(o)) return o;
  return hotspotOrigin(o, env);
}

/**
 * The address to answer this request for, no trailing slash: the configured address it came on; without
 * APP_URL (a box nobody configured an address for) the host it came on; otherwise APP_URL.
 */
export function requestOrigin(req: Request, env: Env): string {
  const listed = listedRequestOrigin(req, env);
  if (listed) return listed;
  const main = mainOrigin(env);
  if (main) return main;
  return arrivalOrigin(req, env) ?? "http://localhost";
}

/** Is `origin` an address of this instance a sign-in may return to (APP_URL or an EXTRA_ORIGINS entry)? */
export function isInstanceOrigin(origin: string, env: Env): boolean {
  return instanceOrigins(env).includes(origin);
}

/**
 * GET /.well-known/webauthn — the WebAuthn related origins of RP_ID: every address a passkey ceremony may come
 * from. A browser on an https address outside RP_ID's domain (a 44Net name beside an internet one) fetches
 * this from `https://<RP_ID>/` and then accepts that relying party there. Every address answers it; browsers
 * ask only RP_ID's.
 */
export function handleWebauthnOrigins(env: Env): Response {
  return new Response(JSON.stringify({ origins: passkeyOrigins(env) }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}

/** The origins allowed to make *credentialed* (cookie-bearing) cross-origin requests —
 *  APP_URL, the instance's other addresses (EXTRA_ORIGINS) and any CORS_ORIGINS, each only when it is https
 *  or loopback: a page on a plain-http origin can be rewritten by anyone on its network path, so it never
 *  rides a member's cookie across origins (the app on that origin is same-origin and needs no CORS). An empty
 *  list allows none: an unconfigured instance serves only non-credentialed CORS, so no third-party page can
 *  ride a signed-in user's cookie. */
export function corsAllowlist(env: Env): Set<string> {
  const list = new Set<string>();
  const add = (u?: string) => {
    const s = u?.trim();
    if (!s) return;
    try {
      const origin = new URL(s).origin;
      if (secureOrigin(origin)) list.add(origin);
    } catch {
      /* ignore a malformed entry */
    }
  };
  add(env.APP_URL);
  for (const o of extraOrigins(env)) add(o);
  for (const o of (env.CORS_ORIGINS ?? "").split(",")) add(o);
  return list;
}

/** A browser POST must come from this gateway's own page or the configured app origins. A request with
 *  no Origin header is a non-browser client (a script holding the token), which no page can forge. */
export function sameSiteOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    const o = new URL(origin);
    return o.host === new URL(req.url).host || corsAllowlist(env).has(o.origin);
  } catch {
    return false; // "null" (sandboxed/opaque) or garbage
  }
}

/**
 * Is this a state-changing request that rides the session cookie from a page outside the instance? The
 * cookie is SameSite=Lax, which keeps it off cross-site requests only: a page on another port of the same
 * host, or on a sibling subdomain, is same-site, and its POST carries the cookie. A text/plain body needs no
 * preflight, so the request itself must say where it came from. The browser's Sec-Fetch-Site decides when it
 * is sent (same-origin, or a direct navigation, or else a configured app origin); without it the Origin
 * header does. A request without the cookie (ingest, federation, a box, a Bearer key) is not one.
 */
export function crossOriginWrite(req: Request, env: Env): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (!/(?:^|;\s*)acs=/.test(req.headers.get("cookie") ?? "")) return false;
  const site = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (site === undefined) return !sameSiteOrigin(req, env);
  if (site === "same-origin" || site === "none") return false;
  const origin = req.headers.get("origin");
  return origin === null || !corsAllowlist(env).has(origin);
}
