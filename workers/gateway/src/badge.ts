// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * badge.ts — an embeddable SVG badge for QRZ.com / forum signatures / other ham networks.
 * GET /badge/:callsign.svg renders the operator's standing in the aprscaching network (network
 * rank, verified finds, points, hides). It's a self-contained SVG (no external fonts/assets) so it
 * renders anywhere an <img> does. This is one way the platform advertises itself as a *network*.
 */
import type { Env } from "./env.js";
import { FREDOKA_DATA_URI } from "./brandfont.js";

const POINTS = "(CASE l.tier WHEN 'A' THEN 10 WHEN 'B' THEN 5 ELSE 2 END) + COALESCE(c.difficulty,0) + COALESCE(c.terrain,0)";
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

export async function handleBadge(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const stat = await env.DB.prepare(
    `SELECT COUNT(*) AS finds, COALESCE(SUM(pts),0) AS points FROM (
       SELECT l.cache_id, MAX(${POINTS}) AS pts FROM cache_logs l JOIN caches c ON c.id=l.cache_id
       WHERE l.logger_call=? AND l.log_type='found' AND l.verified=1 GROUP BY l.cache_id)`,
  ).bind(cs).first<{ finds: number; points: number }>();
  const finds = stat?.finds ?? 0, points = Math.round(stat?.points ?? 0);

  // network rank by points (loggers strictly ahead + 1); only meaningful once they have finds
  let rank = 0;
  if (finds > 0) {
    const r = await env.DB.prepare(
      `WITH agg AS (
         SELECT logger_call, SUM(pts) AS points FROM (
           SELECT l.logger_call, l.cache_id, MAX(${POINTS}) AS pts FROM cache_logs l JOIN caches c ON c.id=l.cache_id
           WHERE l.log_type='found' AND l.verified=1 GROUP BY l.logger_call, l.cache_id) GROUP BY logger_call)
       SELECT COUNT(*)+1 AS rank FROM agg WHERE points > ?`,
    ).bind(points).first<{ rank: number }>();
    rank = r?.rank ?? 0;
  }
  const hides = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM caches WHERE owner_call=? AND source='native' AND status!='archived'",
  ).bind(cs).first<{ n: number }>())?.n ?? 0;

  const instance = env.INSTANCE ?? new URL(req.url).host;
  const svg = renderBadge({ callsign: cs, finds, points, rank, hides, instance });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=600",
      "access-control-allow-origin": "*",
    },
  });
}

const FONT = `'Fredoka','system-ui',sans-serif`;
function renderBadge(d: { callsign: string; finds: number; points: number; rank: number; hides: number; instance: string }): string {
  const W = 360, H = 96;
  const stat = (label: string, value: string, x: number) =>
    `<text x="${x}" y="58" font-size="22" font-weight="600" fill="#fff" font-family="${FONT}">${value}</text>` +
    `<text x="${x}" y="76" font-size="11" font-weight="500" fill="rgba(255,255,255,.85)" font-family="${FONT}">${label}</text>`;
  const rankStr = d.rank > 0 ? `#${d.rank}` : "—";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.callsign)} on aprscaching">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2D8BAB"/><stop offset="1" stop-color="#246f88"/></linearGradient>
    <style>@font-face{font-family:'Fredoka';font-style:normal;font-weight:600;src:url(${FREDOKA_DATA_URI}) format('woff2');}text{font-family:${FONT};}</style>
  </defs>
  <rect width="${W}" height="${H}" rx="12" fill="url(#g)"/>
  <circle cx="28" cy="30" r="9" fill="#7BB912"/>
  <text x="44" y="35" font-size="17" font-weight="600" fill="#fff">APRScaching</text>
  <text x="${W - 16}" y="26" text-anchor="end" font-size="20" font-weight="600" fill="#7BB912">${esc(d.callsign)}</text>
  <text x="${W - 16}" y="40" text-anchor="end" font-size="10" font-weight="500" fill="rgba(255,255,255,.7)">${esc(d.instance)}</text>
  ${stat("network rank", rankStr, 20)}
  ${stat("finds", String(d.finds), 130)}
  ${stat("points", String(d.points), 215)}
  ${stat("hides", String(d.hides), 300)}
</svg>`;
}
