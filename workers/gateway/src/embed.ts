// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * embed.ts — embeddable map widget + QR. A self-contained HTML map for iframes, and a
 * QR SVG for cache deep-links / share URLs. Both are public, CORS-open, and read-only.
 *
 *   GET /embed?cache=:code        iframe map centred on a cache
 *   GET /embed?bbox=...           iframe map of an area
 *   GET /embed/qr.svg?cache=:code QR for the cache's share link
 *   GET /embed/qr.svg?url=...     QR for an arbitrary (length-capped) URL
 */
import type { Env } from "./env.js";
import { appBase } from "./sitemap.js";
import { qrSvg } from "./qr.js";

const escAttr = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** SR-SEC-03: serialise JSON safely for embedding in an inline <script>. JSON.stringify does NOT
 *  escape `<`, `>`, `&`, or the line separators, so a raw value like `</script><script>…` breaks out
 *  of the script element. Escaping these to \uXXXX keeps the value a string, never markup. */
const jsonForScript = (o: unknown) =>
  JSON.stringify(o)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** A bbox query param is trusted only if it is exactly four finite numbers; anything else → null. */
function safeBbox(raw: string | null): string | null {
  if (!raw) return null;
  const p = raw.split(",");
  if (p.length !== 4) return null;
  const n = p.map(Number);
  return n.every((x) => Number.isFinite(x)) ? n.join(",") : null;
}

/** GET /embed — a dependency-light MapLibre widget that reads the public API. */
export function handleEmbed(req: Request, env: Env): Response {
  const u = new URL(req.url);
  const cache = u.searchParams.get("cache");
  const bbox = safeBbox(u.searchParams.get("bbox"));
  const api = u.origin; // the gateway serves this page → its own origin hosts /api/v1
  const app = appBase(env);
  // cache code: letters/digits/hyphen only — never markup, even before JSON escaping
  const safeCache = cache ? cache.toUpperCase().replace(/[^A-Z0-9-]/g, "") || null : null;
  const cfg = jsonForScript({ api, app, cache: safeCache, bbox });
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>aprscaching map</title>
<link href="https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css" rel="stylesheet">
<style>html,body,#m{height:100%;margin:0}#m{font:14px system-ui}
.acg-cta{position:absolute;left:8px;bottom:8px;z-index:2;background:#0b76b8;color:#fff;padding:6px 10px;border-radius:8px;text-decoration:none;font:600 13px system-ui}
.maplibregl-popup-content{font:13px system-ui}</style></head>
<body><div id="m"></div>
<a class="acg-cta" id="cta" href="${escAttr(app)}" target="_blank" rel="noopener">Open in aprscaching →</a>
<script src="https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js"></script>
<script>
const CFG = ${cfg};
const osm = { version:8, sources:{ osm:{ type:'raster', tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize:256, attribution:'© OpenStreetMap' } }, layers:[{ id:'osm', type:'raster', source:'osm' }] };
const map = new maplibregl.Map({ container:'m', style: osm, center:[15.43,47.07], zoom:11 });
function pin(c){
  if(c.lat==null||c.lon==null) return;
  const el=document.createElement('div'); el.style.cssText='width:16px;height:16px;border-radius:50% 50% 50% 0;background:#0b76b8;border:2px solid #fff;transform:rotate(-45deg);box-shadow:0 1px 3px rgba(0,0,0,.4)';
  new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([c.lon,c.lat])
    .setPopup(new maplibregl.Popup({offset:12}).setHTML('<b>'+(c.code||'')+'</b><br>'+(c.title||''))).addTo(map);
  return [c.lon,c.lat];
}
map.on('load', async () => {
  try {
    if (CFG.cache) {
      const d = await (await fetch(CFG.api+'/api/v1/caches/'+encodeURIComponent(CFG.cache))).json();
      const c = d.cache || d; const ll = pin(c); if (ll) map.flyTo({center:ll, zoom:14});
      document.getElementById('cta').href = CFG.app+'/?cache='+encodeURIComponent(CFG.cache);
    } else {
      const bbox = CFG.bbox || '-180,-90,180,90';
      const d = await (await fetch(CFG.api+'/api/v1/caches?bbox='+bbox)).json();
      const b = new maplibregl.LngLatBounds();
      (d.caches||[]).forEach(c => { const ll = pin(c); if (ll) b.extend(ll); });
      if (!b.isEmpty()) map.fitBounds(b, {padding:40, maxZoom:14});
    }
  } catch (e) { /* offline / blocked tiles — the map chrome still renders */ }
});
</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Embeddable by design (frame-ancestors *), but lock down what may execute/connect as
      // defence-in-depth behind the JSON escaping above (SR-SEC-03). No plugins, no <base> hijack.
      "content-security-policy": [
        "default-src 'none'",
        "script-src 'unsafe-inline' https://unpkg.com",
        "style-src 'unsafe-inline' https://unpkg.com",
        "img-src 'self' data: https://tile.openstreetmap.org",
        `connect-src 'self' ${api}`,
        "frame-ancestors *",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    },
  });
}

/** GET /embed/qr.svg — QR for a cache share link (?cache=) or an arbitrary URL (?url=). */
export function handleQr(req: Request, env: Env): Response {
  const u = new URL(req.url);
  const cache = u.searchParams.get("cache");
  const url = u.searchParams.get("url");
  const data = cache ? `${appBase(env)}/?cache=${encodeURIComponent(cache.toUpperCase())}` : url || appBase(env);
  if (new TextEncoder().encode(data).length > 106) return new Response("data too long", { status: 400 });
  const sizeParam = Number(u.searchParams.get("size"));
  try {
    const svg = qrSvg(data, { size: Number.isFinite(sizeParam) && sizeParam > 0 ? Math.min(sizeParam, 1024) : 256 });
    return new Response(svg, {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
