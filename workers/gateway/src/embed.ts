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
import { DEFAULT_BASEMAP_STYLE, GRATICULE_PALETTE, MAPLIBRE_VENDOR_DIR } from "@aprscaching/shared";
import { gatewayBase } from "./sitemap.js";
import { requestOrigin } from "./origins.js";
import { qrSvg } from "./qr.js";
import { escapeHtml } from "./util/html.js";

/** Serialise JSON safely for embedding in an inline <script>. JSON.stringify does NOT
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

/** The origin of an http(s) URL, or null for anything else (another scheme, not a URL at all). */
function httpOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The widget's basemap from BASEMAP_STYLE: unset ⇒ the web app's default online style; `offline` ⇒ the
 * self-contained grid (style null), which fetches nothing; an http(s) style URL ⇒ that style. Anything
 * else is treated as offline, so a mistyped value never widens the page's CSP. `hosts` are the origins
 * the style may load from: the style's own origin plus BASEMAP_HOSTS, for a style whose tiles, glyphs
 * or sprites live on other hosts.
 */
function basemap(env: Env): { style: string | null; hosts: string[] } {
  const raw = env.BASEMAP_STYLE?.trim() || DEFAULT_BASEMAP_STYLE;
  const origin = raw.toLowerCase() === "offline" ? null : httpOrigin(raw);
  if (!origin) return { style: null, hosts: [] };
  const extra = (env.BASEMAP_HOSTS ?? "").split(",").flatMap((h) => httpOrigin(h) ?? []);
  return { style: new URL(raw).href, hosts: [...new Set([origin, ...extra])] };
}

/**
 * GET /embed — a MapLibre widget that reads the public API. MapLibre itself comes from the instance's own
 * web build (MAPLIBRE_VENDOR_DIR on the address the widget was loaded from, which serves the web app beside
 * the gateway), and the basemap from BASEMAP_STYLE, so the widget needs no third-party host beyond the
 * basemap the instance chose — none at all with `offline`. A widget loaded over HAMNET stays on HAMNET.
 */
export function handleEmbed(req: Request, env: Env): Response {
  const u = new URL(req.url);
  const cache = u.searchParams.get("cache");
  const bbox = safeBbox(u.searchParams.get("bbox"));
  // the gateway serves this page → its own address hosts /api/v1, the web app and MapLibre
  const self = gatewayBase(req, env);
  const app = self;
  const lib = `${self}/${MAPLIBRE_VENDOR_DIR}`;
  const libSrc = "'self'";
  const map = basemap(env);
  // cache code: letters/digits/hyphen only — never markup, even before JSON escaping
  const safeCache = cache ? cache.toUpperCase().replace(/[^A-Z0-9-]/g, "") || null : null;
  const cfg = jsonForScript({
    api: self,
    app,
    cache: safeCache,
    bbox,
    lib: `${lib}/maplibre-gl.js`,
    worker: `${lib}/maplibre-gl-worker.js`,
    style: map.style,
    grid: GRATICULE_PALETTE,
  });
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>aprscaching map</title>
<link rel="icon" href="data:,">
<link href="${escapeHtml(lib)}/maplibre-gl.css" rel="stylesheet">
<style>html,body,#m{height:100%;margin:0}#m{font:14px system-ui}
.acg-cta{position:absolute;left:8px;bottom:8px;z-index:2;background:#0b76b8;color:#fff;padding:6px 10px;border-radius:8px;text-decoration:none;font:600 13px system-ui}
.acg-pin{width:16px;height:16px;border-radius:50% 50% 50% 0;background:#0b76b8;border:2px solid #fff;transform:rotate(-45deg);box-shadow:0 1px 3px rgba(0,0,0,.4)}
.maplibregl-popup-content{font:13px system-ui}</style></head>
<body><div id="m"></div>
<a class="acg-cta" id="cta" href="${escapeHtml(app)}" target="_blank" rel="noopener">Open in aprscaching →</a>
<script type="module">
const CFG = ${cfg};
const maplibregl = await import(CFG.lib);
maplibregl.setWorkerUrl(CFG.worker);
// The self-contained lat/lon grid (the web app's offline basemap): drawn here, so it fetches nothing.
function grid(p, step){
  const minor=[], major=[], r=n=>Math.round(n*1000)/1000;
  const line=c=>({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:c}});
  for(let x=-180;x<=180;x+=step)(r(x)%1===0?major:minor).push(line([[x,-85],[x,85]]));
  for(let y=-85;y<=85;y+=step)(r(y)%1===0?major:minor).push(line([[-180,y],[180,y]]));
  const fc=f=>({type:'FeatureCollection',features:f});
  return { version:8, sources:{ grid_minor:{type:'geojson',data:fc(minor)}, grid_major:{type:'geojson',data:fc(major)} },
    layers:[ {id:'ocean',type:'background',paint:{'background-color':p.bg}},
      {id:'grid-minor',type:'line',source:'grid_minor',paint:{'line-color':p.line,'line-opacity':p.minorOp,'line-width':p.minorW}},
      {id:'grid-major',type:'line',source:'grid_major',paint:{'line-color':p.line,'line-opacity':p.majorOp,'line-width':p.majorW}} ] };
}
const map = new maplibregl.Map({ container:'m', style: CFG.style || grid(CFG.grid, 0.1), center:[15.43,47.07], zoom:11 });
function pin(c){
  if(c.lat==null||c.lon==null) return;
  const el=document.createElement('div'); el.className='acg-pin';
  const tip=document.createElement('div'); const b=document.createElement('b');
  b.textContent=c.code||''; tip.append(b, document.createElement('br'), c.title||'');
  new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([c.lon,c.lat])
    .setPopup(new maplibregl.Popup({offset:12}).setDOMContent(tip)).addTo(map);
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
  } catch (e) { /* the API is unreachable — the map still renders */ }
});
</script></body></html>`;
  const hosts = map.hosts.map((h) => " " + h).join("");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Embeddable by design (frame-ancestors *), but lock down what may execute/connect as
      // defence-in-depth behind the JSON escaping above. Scripts, styles and the worker come only from this
      // origin; MapLibre starts a cross-origin worker from a blob: that imports it. Fetches reach only
      // this gateway and the basemap's hosts. No plugins, no <base> hijack.
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${libSrc}`,
        `style-src 'unsafe-inline' ${libSrc}`,
        `worker-src ${libSrc} blob:`,
        `img-src 'self' data: blob:${hosts}`,
        `connect-src 'self'${hosts}`,
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
  const data = cache
    ? `${requestOrigin(req, env)}/?cache=${encodeURIComponent(cache.toUpperCase())}`
    : url || requestOrigin(req, env);
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
