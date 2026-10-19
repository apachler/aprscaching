// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The response headers every page of the instance carries: the web app's files, whichever host serves them
 * (the Node server with WEB_DIST, the desktop launcher, and Caddy in deploy/Caddyfile and Cloudflare Pages in
 * apps/web/public/_headers, which write the same values out), and the gateway's own HTML pages (imprint,
 * privacy, support, sitemap, the notify page).
 *
 * - The frame policy keeps another site from framing the app over the signed-in user's view. Same-origin
 *   framing stays allowed: the UI kit demo frames the app itself. The embed widget (`/embed`) sets its own
 *   policy, `frame-ancestors *`, and a page that sets a policy of its own keeps it.
 * - `base-uri` and `object-src` close two injection routes a script-source policy would not; the script and
 *   connect sources stay open, because the app's inline head scripts, MapLibre's blob workers, the
 *   WebAssembly modem and the tool sandbox's srcdoc frame (which inherits the policy) all need allowances.
 * - The referrer policy is the browsers' default, stated: tile servers that require a referrer get the
 *   origin, never the path.
 *
 * The module imports nothing, so a host's launcher loads it on its own.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/**
 * `res` with PAGE_HEADERS added when it is an HTML page. A header the page already sets wins: a page with a
 * content security policy of its own keeps its frame policy, so no X-Frame-Options is added beside it, and a
 * page that sets `X-Frame-Options: DENY` gets `frame-ancestors 'none'`, since a browser that reads the policy
 * ignores X-Frame-Options.
 */
export function withPageHeaders(res: Response): Response {
  if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;
  const ownPolicy = res.headers.has("content-security-policy");
  const h = new Headers(res.headers);
  let changed = false;
  for (const [k, v] of Object.entries(PAGE_HEADERS)) {
    if (h.has(k) || (ownPolicy && k === "x-frame-options")) continue;
    const deny = k === "content-security-policy" && h.get("x-frame-options")?.toUpperCase() === "DENY";
    h.set(k, deny ? v.replace("frame-ancestors 'self'", "frame-ancestors 'none'") : v);
    changed = true;
  }
  return changed ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: h }) : res;
}
