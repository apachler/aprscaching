// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * live.ts — the real-time layer. As positions arrive at /ingest we compute, per position, a live
 * envelope (a station delta + any geofence prompts for caches within radius) and dispatch it to the
 * region room. The room delivers to each subscriber by their subscription: station deltas to anyone
 * whose bbox contains the point, geofence prompts to the subscriber whose callsign matches.
 *
 * `deliveriesFor` is pure and runtime-neutral so the Durable Object (Worker) and the in-memory
 * rooms (Node) share identical delivery semantics.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import type { Subscribe, ServerMsg, StationDelta, GeofencePrompt } from "@aprscaching/shared";
import { baseCall, haversineMeters } from "@aprscaching/aprs";
import { dispatchBudget, settleDispatch } from "./budget.js";

const GEOFENCE_RADIUS_M = 150;
export const LIVE_REGION = "global"; // a single global region; geohash sharding is a reserved scaling seam

/**
 * The live room a `/ws?region=` upgrade joins, or null for a region this instance does not serve. Only
 * {@link LIVE_REGION} has a room that anything is dispatched to, so any other name would only open an empty
 * room per distinct string.
 */
export function liveRegionOf(url: URL): string | null {
  const region = url.searchParams.get("region") ?? LIVE_REGION;
  return region === LIVE_REGION ? region : null;
}

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
    // a prompt goes to the person: the subscriber's base call matches a beacon from any of its SSIDs
    const cs = baseCall(sub.callsign.toUpperCase());
    for (const p of env.prompts) if (baseCall(p.forCallsign) === cs) out.push(p.prompt);
  }
  return out;
}

/** A listed, active cache within {@link GEOFENCE_RADIUS_M} of a position. */
export interface NearCache {
  id: number;
  code: string;
  title: string;
  lat: number;
  lon: number;
  distanceM: number;
}

/** The listed, active caches within {@link GEOFENCE_RADIUS_M} of a point: one indexed bbox read. */
export async function cachesNear(env: Env, lat: number, lon: number): Promise<NearCache[]> {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const dLat = GEOFENCE_RADIUS_M / 111320;
  const dLon = GEOFENCE_RADIUS_M / (111320 * cosLat);
  const rows = (
    await env.DB.prepare(
      `SELECT id, code, title, lat, lon FROM caches
      WHERE status = 'active' AND fed_scope != 'unlisted' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 50`,
    )
      .bind(lat - dLat, lat + dLat, lon - dLon, lon + dLon)
      .all<{ id: number; code: string; title: string; lat: number; lon: number }>()
  ).results;

  const near: NearCache[] = [];
  for (const c of rows) {
    if (c.lat == null || c.lon == null) continue;
    const distanceM = haversineMeters(lat, lon, c.lat, c.lon);
    if (distanceM <= GEOFENCE_RADIUS_M) near.push({ ...c, distanceM });
  }
  return near;
}

/**
 * Build the live envelope for one ingested position: a station delta + a geofence prompt per nearby cache.
 * `near` is the result of {@link cachesNear} when the caller has it already.
 */
export async function envelopeForPosition(
  env: Env,
  callsign: string,
  lat: number,
  lon: number,
  symbol?: string,
  course?: number,
  near?: NearCache[],
): Promise<LiveEnvelope> {
  const cs = callsign.toUpperCase();
  const station: StationDelta = {
    type: "station",
    callsign: cs,
    lat,
    lon,
    symbol,
    course,
    lastSeen: nowS(),
  };
  const around = near ?? (await cachesNear(env, lat, lon));
  const own = around.length ? await ownedAmong(env, cs, around) : new Set<number>();
  const prompts = around
    .filter((c) => !own.has(c.id))
    .map((c) => ({
      forCallsign: cs,
      prompt: {
        type: "near_cache",
        cacheId: c.id,
        code: c.code,
        title: c.title,
        distanceM: c.distanceM,
      } satisfies GeofencePrompt,
    }));
  return { station, prompts: prompts.length ? prompts : undefined };
}

/**
 * The caches among `caches` that the station's operator hid: under the station's base call or an SSID of it, or
 * under any call of the account that holds it. A hider is never prompted to log their own cache.
 */
async function ownedAmong(env: Env, callsign: string, caches: NearCache[]): Promise<Set<number>> {
  const base = baseCall(callsign);
  const ids = caches.map((c) => c.id);
  const rows = (
    await env.DB.prepare(
      `SELECT c.id FROM caches c WHERE c.id IN (${ids.map(() => "?").join(",")})
         AND (UPPER(c.owner_call) = ? OR UPPER(c.owner_call) LIKE ? || '-%' OR EXISTS (
           SELECT 1 FROM account_callsigns ac
            WHERE ac.account_id = (SELECT account_id FROM account_callsigns WHERE callsign = ?)
              AND (UPPER(c.owner_call) = ac.callsign OR UPPER(c.owner_call) LIKE ac.callsign || '-%')))`,
    )
      .bind(...ids, base, base, base)
      .all<{ id: number }>()
  ).results;
  return new Set(rows.map((r) => r.id));
}

/** Send envelopes to the region room (DO on Workers, in-memory rooms on Node) via its fetch entry. */
export async function dispatchLive(env: Env, envelopes: LiveEnvelope[], region = LIVE_REGION): Promise<void> {
  // the global room also keeps the write budget: the pending written rows ride along (budget.ts)
  const budget = region === LIVE_REGION ? dispatchBudget(env) : null;
  if (!envelopes.length && !budget) return;
  const room = env.ROOMS.get(env.ROOMS.idFromName(region));
  const res = await room
    .fetch(
      new Request("https://room/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelopes, ...(budget ? { budget } : {}) }),
      }),
    )
    .catch(() => null); // room unavailable; live is best-effort
  await settleDispatch(env, budget, res);
}
