/**
 * sitemap.ts — machine- and human-readable map of the app, generated from the shared SURFACES
 * manifest (packages/shared). One source of truth feeds the standalone /sitemap page, crawlers, and
 * any dynamic tooling (e.g. the teaser tour).
 *
 *   GET /sitemap         human-readable site map page (linked from the landing footer)
 *   GET /sitemap.xml     XML sitemap of public, linkable surfaces (deep-linked via ?view=)
 *   GET /api/sitemap     JSON: the full surface manifest + feed catalogue (for tooling)
 *   GET /robots.txt      allow-all + a Sitemap: pointer
 *
 * Runtime-neutral (Worker / Node / Bun): no host-only globals.
 */
import type { Env } from "./env.js";
import { json, xml } from "./app.js";
import { SURFACES, SURFACE_GROUPS, FEEDS, type SurfaceGroup } from "@aprsweb/shared";

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

/** GET /sitemap — human-readable site map: a real, crawlable page (not an in-app panel), built from
 *  the same SURFACES manifest. Joins /support + /source as a server-rendered top-level page. */
export function handleSitemapPage(_req: Request, env: Env): Response {
  const base = appBase(env);
  const e = xmlEscape;
  const groupHtml = SURFACE_GROUPS.map((group: SurfaceGroup) => {
    const items = SURFACES.filter((s) => s.group === group);
    if (!items.length) return "";
    const rows = items.map((s) => {
      const badge = s.access === "account" ? ` <span class=tag>account</span>` : "";
      return `<li><a href="${e(surfaceUrl(env, s.view))}">${e(s.title)}</a>${badge}<div class=m>${e(s.summary)}</div></li>`;
    }).join("");
    return `<section><h2>${e(group)}</h2><ul>${rows}</ul></section>`;
  }).join("");
  const feedHtml = FEEDS.map((f) =>
    `<li><a href="${e(base + f.path)}">${e(f.title)}</a><div class=m>${e(f.summary)}</div></li>`).join("");
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Site map · aprscaching</title><style>
:root{color-scheme:dark light}body{font:15px/1.55 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin:1.4rem 0 .4rem;text-transform:uppercase;letter-spacing:.05em;opacity:.75}
ul{list-style:none;padding:0;margin:0}li{padding:.55rem 0;border-bottom:1px solid #8883}
a{font-weight:600;text-decoration:none}a:hover{text-decoration:underline}.m{opacity:.7;font-size:.9em;margin-top:.15rem}
.tag{font-size:.72em;border:1px solid #8886;border-radius:4px;padding:0 .35em;opacity:.8;vertical-align:middle}
footer{margin-top:2rem;opacity:.7;font-size:.9em}</style>
<h1>Site map</h1>
<p class=m>Every page and tool on aprscaching, linked. <a href="${e(base)}/">Open the app</a>.</p>
${groupHtml}
<section><h2>Feeds (RSS)</h2><ul>${feedHtml}</ul></section>
<section><h2>For machines</h2><ul>
<li><a href="${e(base)}/sitemap.xml">sitemap.xml</a><div class=m>XML sitemap for crawlers.</div></li>
<li><a href="${e(base)}/api/sitemap">/api/sitemap</a><div class=m>JSON surface manifest + feed catalogue.</div></li>
<li><a href="${e(base)}/api/v1">/api/v1</a><div class=m>Public read API — free, rate-limited (ADR-4a).</div></li>
</ul></section>
<footer><a href="${e(base)}/support">Support</a> · <a href="${e(base)}/source">Source (AGPL-3.0)</a></footer>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** GET /robots.txt — allow all + advertise the sitemap. */
export function handleRobots(_req: Request, env: Env): Response {
  const body = `User-agent: *\nAllow: /\nSitemap: ${appBase(env)}/sitemap.xml\n`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
