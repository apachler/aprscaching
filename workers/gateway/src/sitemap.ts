/**
 * sitemap.ts — machine-readable map of the app, generated from the shared SURFACES manifest
 * (packages/shared). One source of truth feeds the in-app Site map page, crawlers, and any dynamic
 * tooling (e.g. the teaser tour).
 *
 *   GET /sitemap.xml     XML sitemap of public, linkable surfaces (deep-linked via ?view=)
 *   GET /api/sitemap     JSON: the full surface manifest + feed catalogue (for tooling)
 *   GET /robots.txt      allow-all + a Sitemap: pointer
 *
 * Runtime-neutral (Worker / Node / Bun): no host-only globals.
 */
import type { Env } from "./env.js";
import { json, xml } from "./app.js";
import { SURFACES, FEEDS } from "@aprsweb/shared";

const CANONICAL = "https://aprscaching.net";

/** The public app origin (env override → canonical host), no trailing slash. */
export function appBase(env: Env): string {
  return (env.APP_URL || CANONICAL).replace(/\/+$/, "");
}

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

/** A deep-link URL for a surface: the map is the root, panels carry `?view=<key>`. */
export function surfaceUrl(env: Env, view: string | null): string {
  const base = appBase(env);
  return view ? `${base}/?view=${encodeURIComponent(view)}` : `${base}/`;
}

/** GET /sitemap.xml — public, indexable surfaces as a standard urlset. */
export function handleSitemapXml(_req: Request, env: Env): Response {
  const urls = SURFACES.filter((s) => s.indexable).map((s) =>
    `  <url>\n    <loc>${xmlEscape(surfaceUrl(env, s.view))}</loc>\n` +
    `    <changefreq>${s.view === null ? "hourly" : "daily"}</changefreq>\n` +
    `    <priority>${s.view === null ? "1.0" : "0.6"}</priority>\n  </url>`,
  );
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return xml(body);
}

/** GET /api/sitemap — the full manifest + feed catalogue, for dynamic tooling. */
export function handleSitemapJson(_req: Request, env: Env): Response {
  const base = appBase(env);
  return json({
    protocol: "aprscaching-sitemap/1",
    app: base,
    surfaces: SURFACES.map((s) => ({ ...s, url: surfaceUrl(env, s.view) })),
    feeds: FEEDS.map((f) => ({ ...f, url: `${base}${f.path}` })),
    readApi: { version: "v1", path: "/api/v1", access: "free, rate-limited (ADR-4a)" },
  });
}

/** GET /robots.txt — allow all + advertise the sitemap. */
export function handleRobots(_req: Request, env: Env): Response {
  const body = `User-agent: *\nAllow: /\nSitemap: ${appBase(env)}/sitemap.xml\n`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
