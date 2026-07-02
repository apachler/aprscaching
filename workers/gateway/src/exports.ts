// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * exports.ts — public read-API exports: caches as GPX (GPS devices) / KML (Earth),
 * and a callsign's finds as ADIF (standard logbooks — Log4OM/N1MM/DXLab). Pure builders + read-only
 * queries; served under /api/v1 behind the same rate-limit gate. Runtime-neutral.
 */
import type { Env } from "./env.js";
import { xmlEscape } from "./sitemap.js";

export interface ExpCache { code: string; title: string; type: string; difficulty: number; terrain: number; lat: number; lon: number; ownerCall: string }
export interface ExpFind { code: string; title: string; ownerCall: string; stationCall: string | null; ts: number }

const dt = (c: ExpCache) => `D${c.difficulty}/T${c.terrain}`;

/** GPX 1.1 waypoints (one per cache). */
export function cachesToGpx(caches: ExpCache[]): string {
  const wpts = caches.map((c) =>
    `  <wpt lat="${c.lat}" lon="${c.lon}">\n` +
    `    <name>${xmlEscape(c.code)}</name>\n` +
    `    <desc>${xmlEscape(`${c.title} — ${c.type} · ${dt(c)} · by ${c.ownerCall}`)}</desc>\n` +
    `    <type>${xmlEscape(c.type)}</type>\n    <sym>Geocache</sym>\n  </wpt>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="aprscaching" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n</gpx>\n`;
}

/** KML placemarks (one per cache). */
export function cachesToKml(caches: ExpCache[]): string {
  const marks = caches.map((c) =>
    `  <Placemark>\n    <name>${xmlEscape(c.code)}</name>\n` +
    `    <description>${xmlEscape(`${c.title} — ${c.type} · ${dt(c)} · by ${c.ownerCall}`)}</description>\n` +
    `    <Point><coordinates>${c.lon},${c.lat},0</coordinates></Point>\n  </Placemark>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>aprscaching caches</name>\n${marks}\n  </Document>\n</kml>\n`;
}

const adifField = (name: string, value: string): string => `<${name}:${new TextEncoder().encode(value).length}>${value}`;
const pad = (n: number) => String(n).padStart(2, "0");

/** ADIF 3.1 records (one per find), mapping each find to a logbook QSO with the cache as SIG_INFO. */
export function findsToAdif(finds: ExpFind[], call: string): string {
  const header = `aprscaching ADIF export for ${call}\n` +
    `${adifField("ADIF_VER", "3.1.4")} ${adifField("PROGRAMID", "aprscaching")} <EOH>\n`;
  const records = finds.map((f) => {
    const d = new Date(f.ts * 1000);
    const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const station = (f.stationCall || f.ownerCall || f.code).toUpperCase();
    return [
      adifField("CALL", station), adifField("QSO_DATE", date), adifField("TIME_ON", time),
      adifField("MODE", "FM"), adifField("SIG", "APRSCACHING"), adifField("SIG_INFO", f.code),
      adifField("COMMENT", `Found ${f.title} (${f.code})`), "<EOR>",
    ].join(" ");
  }).join("\n");
  return header + records + (records ? "\n" : "");
}

// ---- read-only data ----
function parseBbox(req: Request): [number, number, number, number] {
  const [minLon, minLat, maxLon, maxLat] = (new URL(req.url).searchParams.get("bbox") ?? "-180,-90,180,90").split(",").map(Number) as [number, number, number, number];
  return [minLon, minLat, maxLon, maxLat];
}
async function bboxCaches(env: Env, [minLon, minLat, maxLon, maxLat]: [number, number, number, number]): Promise<ExpCache[]> {
  const rows = (await env.DB.prepare(
    `SELECT code, title, type, difficulty, terrain, lat, lon, owner_call AS ownerCall
       FROM caches WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND status != 'archived' AND lat IS NOT NULL AND lon IS NOT NULL
       LIMIT 2000`,
  ).bind(minLat, maxLat, minLon, maxLon).all<ExpCache>()).results;
  return rows;
}

function download(body: string, type: string, filename: string): Response {
  return new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "content-disposition": `attachment; filename="${filename}"` } });
}

export async function handleCachesGpx(req: Request, env: Env): Promise<Response> {
  return download(cachesToGpx(await bboxCaches(env, parseBbox(req))), "application/gpx+xml", "aprscaching-caches.gpx");
}
export async function handleCachesKml(req: Request, env: Env): Promise<Response> {
  return download(cachesToKml(await bboxCaches(env, parseBbox(req))), "application/vnd.google-earth.kml+xml", "aprscaching-caches.kml");
}
export async function handleCacheGpx(req: Request, env: Env, code: string): Promise<Response> {
  const c = await env.DB.prepare(
    "SELECT code, title, type, difficulty, terrain, lat, lon, owner_call AS ownerCall FROM caches WHERE code = ? AND lat IS NOT NULL",
  ).bind(code).first<ExpCache>();
  if (!c) return new Response(JSON.stringify({ error: "cache not found" }), { status: 404, headers: { "content-type": "application/json" } });
  return download(cachesToGpx([c]), "application/gpx+xml", `${code}.gpx`);
}
// ---- station tracks: position history as JSON + KML LineString ----
interface TrackPt { lat: number; lon: number; ts: number; heardVia: string }

async function stationTrack(env: Env, call: string, from: number, until: number): Promise<TrackPt[]> {
  return (await env.DB.prepare(
    `SELECT lat, lon, ts, heard_via AS heardVia FROM positions
       WHERE callsign = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT 5000`,
  ).bind(call, from, until).all<TrackPt>()).results;
}

function trackWindow(req: Request): { from: number; until: number } {
  const u = new URL(req.url);
  const now = Math.floor(Date.now() / 1000);
  const until = Number(u.searchParams.get("to")) || now;
  let from = Number(u.searchParams.get("from")) || until - 24 * 3600;
  if (until - from > 31 * 24 * 3600) from = until - 31 * 24 * 3600; // cap span at 31 days
  return { from, until };
}

export async function handleStationTrack(req: Request, env: Env, call: string): Promise<Response> {
  const { from, until } = trackWindow(req);
  const pts = await stationTrack(env, call, from, until);
  return new Response(JSON.stringify({ callsign: call, from, until, count: pts.length, positions: pts }),
    { headers: { "content-type": "application/json" } });
}

export function trackToKml(call: string, pts: TrackPt[]): string {
  const coords = pts.map((p) => `${p.lon},${p.lat},0`).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>${xmlEscape(call)} track</name>\n` +
    `    <Placemark>\n      <name>${xmlEscape(call)}</name>\n` +
    `      <LineString>\n        <tessellate>1</tessellate>\n        <coordinates>${coords}</coordinates>\n      </LineString>\n` +
    `    </Placemark>\n  </Document>\n</kml>\n`;
}

export async function handleStationKml(req: Request, env: Env, call: string): Promise<Response> {
  const { from, until } = trackWindow(req);
  const pts = await stationTrack(env, call, from, until);
  return download(trackToKml(call, pts), "application/vnd.google-earth.kml+xml", `${call}-track.kml`);
}

export async function handleFindsAdif(req: Request, env: Env, call: string): Promise<Response> {
  const finds = (await env.DB.prepare(
    `SELECT c.code, c.title, c.owner_call AS ownerCall, c.station_call AS stationCall, l.ts
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
       WHERE l.logger_call = ? AND l.log_type = 'found' ORDER BY l.ts DESC LIMIT 2000`,
  ).bind(call).all<ExpFind>()).results;
  return download(findsToAdif(finds, call), "text/plain", `${call}-finds.adif`);
}
