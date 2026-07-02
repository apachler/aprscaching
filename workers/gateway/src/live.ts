// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * live.ts — M2 real-time layer. As positions arrive at /ingest we compute, per position, a live
 * envelope (a station delta + any geofence prompts for caches within radius) and dispatch it to the
 * region room. The room delivers to each subscriber by their subscription: station deltas to anyone
 * whose bbox contains the point, geofence prompts to the subscriber whose callsign matches.
 *
 * `deliveriesFor` is pure and runtime-neutral so the Durable Object (Worker) and the in-memory
 * rooms (Node) share identical delivery semantics.
 */
import type { Env } from "./env.js";
import type { Subscribe, ServerMsg, StationDelta, GeofencePrompt } from "@aprsweb/shared";
import { haversineMeters } from "@aprsweb/aprs";

export const GEOFENCE_RADIUS_M = 150;
export const LIVE_REGION = "global"; // single region for now; sharding is M6

export interface LiveEnvelope {
  station?: StationDelta;
  prompts?: { forCallsign: string; prompt: GeofencePrompt }[];
}

function inBbox(bbox: readonly [number, number, number, number], lat: number, lon: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/** The messages to send to ONE subscriber for an envelope. */
export function deliveriesFor(sub: Subscribe | undefined, env: LiveEnvelope): ServerMsg[] {
  const out: ServerMsg[] = [];
  if (!sub) return out;
  if (env.station && inBbox(sub.bbox, env.station.lat, env.station.lon)) out.push(env.station);
  if (sub.callsign && env.prompts) {
    const cs = sub.callsign.toUpperCase();
    for (const p of env.prompts) if (p.forCallsign === cs) out.push(p.prompt);
  }
  return out;
}

/** Build the live envelope for one ingested position: a station delta + nearby geofence prompts. */
export async function envelopeForPosition(
  env: Env, callsign: string, lat: number, lon: number, symbol?: string, course?: number,
): Promise<LiveEnvelope> {
  const cs = callsign.toUpperCase();
  const station: StationDelta = { type: "station", callsign: cs, lat, lon, symbol, course, lastSeen: Math.floor(Date.now() / 1000) };

  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const dLat = GEOFENCE_RADIUS_M / 111320;
  const dLon = GEOFENCE_RADIUS_M / (111320 * cosLat);
  const rows = (await env.DB.prepare(
    `SELECT id, code, title, lat, lon FROM caches
      WHERE status = 'active' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 50`,
  ).bind(lat - dLat, lat + dLat, lon - dLon, lon + dLon)
    .all<{ id: number; code: string; title: string; lat: number; lon: number }>()).results;

  const prompts: { forCallsign: string; prompt: GeofencePrompt }[] = [];
  for (const c of rows) {
    if (c.lat == null || c.lon == null) continue;
    const distanceM = haversineMeters(lat, lon, c.lat, c.lon);
    if (distanceM <= GEOFENCE_RADIUS_M) {
      prompts.push({ forCallsign: cs, prompt: { type: "near_cache", cacheId: c.id, code: c.code, title: c.title, distanceM } });
    }
  }
  return { station, prompts: prompts.length ? prompts : undefined };
}

/** Send envelopes to the region room (DO on Workers, in-memory rooms on Node) via its fetch entry. */
export async function dispatchLive(env: Env, envelopes: LiveEnvelope[], region = LIVE_REGION): Promise<void> {
  if (!envelopes.length) return;
  const room = env.ROOMS.get(env.ROOMS.idFromName(region));
  await room.fetch(new Request("https://room/dispatch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelopes }),
  })).catch(() => { /* room unavailable; live is best-effort */ });
}
