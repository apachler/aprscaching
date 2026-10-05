// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The paths the gateway serves, as distinct from the SPA's. A host that serves both from one origin
 * (the desktop app; Caddy in deploy/Caddyfile; the Node server with WEB_DIST; the web app's dev server,
 * which proxies them to a local gateway) sends these to handle() and everything else to the SPA.
 * The module imports nothing, so a build tool's config loads it on its own. A test reads every route in
 * app.ts's route() and checks it is claimed here.
 */
const GATEWAY_PATH =
  /^\/(?:api|auth|verify|keys|badge|federation|feeds|embed|v|outbox|ingest|tiles|\.well-known)(?:\/|$)|^\/(?:ws|source|support|imprint|privacy|health|sitemap|sitemap\.xml|robots\.txt)$/;

export const isGatewayPath = (pathname: string): boolean => GATEWAY_PATH.test(pathname);
