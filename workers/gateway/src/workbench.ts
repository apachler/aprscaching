/**
 * workbench.ts — M5 platform depth: a live APRS station registry + a packet inspector.
 * Stations and weather are enriched at ingest time (see ingest.ts) using the @aprsweb/aprs
 * decoder; these read endpoints expose them, plus an on-demand decode tool for raw TNC2 lines.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { parseTNC2, classifyQ, decodeAprs } from "@aprsweb/aprs";

const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------- packet inspector
export async function handleDecode(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { raw?: string };
  const raw = (body.raw ?? "").trim();
  if (!raw) return json({ ok: false, error: "raw TNC2 line required" }, { status: 400 });
  const frame = parseTNC2(raw);
  if (!frame) return json({ ok: false, error: "not a TNC2 frame" }, { status: 400 });
  const q = classifyQ(frame.path);
  const data = decodeAprs(frame);
  return json({
    ok: true,
    frame: { src: frame.src, dst: frame.dst, path: frame.path, payload: frame.payload, heardVia: q.heardVia, igateCall: q.igateCall },
    data,
  });
}

// ------------------------------------------------------------- station registry
function bbox(u: URL): { sql: string; binds: number[] } {
  const b = u.searchParams.get("bbox");
  if (!b) return { sql: "", binds: [] };
  const p = b.split(",").map(Number);
  if (p.length < 4 || p.some(Number.isNaN)) return { sql: "", binds: [] };
  const [minLon, minLat, maxLon, maxLat] = p as [number, number, number, number];
  return { sql: " AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", binds: [minLat, maxLat, minLon, maxLon] };
}

export async function handleStations(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const maxAge = Math.min(Math.max(Number(u.searchParams.get("maxAge") ?? 3600) || 3600, 60), 7 * 86400);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 500) || 500, 1), 2000);
  const bb = bbox(u);
  const rows = (await env.DB.prepare(
    `SELECT callsign, lat, lon, symbol, course, speed_kn AS speedKn, altitude_m AS altitudeM,
            comment, last_seen AS lastSeen
       FROM stations WHERE lat IS NOT NULL AND last_seen >= ?${bb.sql}
      ORDER BY last_seen DESC LIMIT ?`,
  ).bind(now() - maxAge, ...bb.binds, limit).all()).results;
  return json({ stations: rows });
}

export async function handleStation(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const st = await env.DB.prepare(
    `SELECT callsign, lat, lon, symbol, course, speed_kn AS speedKn, altitude_m AS altitudeM,
            comment, last_seen AS lastSeen FROM stations WHERE callsign = ?`,
  ).bind(cs).first();
  if (!st) return json({ error: "unknown station" }, { status: 404 });

  const track = (await env.DB.prepare(
    "SELECT ts, lat, lon, heard_via AS heardVia FROM positions WHERE callsign = ? ORDER BY ts DESC LIMIT 50",
  ).bind(cs).all()).results;
  const wx = await env.DB.prepare(
    `SELECT ts, temp_c AS tempC, humidity, pressure_hpa AS pressureHpa,
            wind_dir AS windDirDeg, wind_kn AS windKn, rain_mm AS rainMm
       FROM sensor_readings WHERE station = ? ORDER BY ts DESC LIMIT 1`,
  ).bind(cs).first();
  const pc = await env.DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE callsign = ?").bind(cs).first<{ n: number }>();

  return json({ station: { ...st, track, wx: wx ?? null, packets: pc?.n ?? 0 } });
}
