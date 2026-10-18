// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * rendezvous.ts — living-cache rendezvous. When a living cache (an aprs_living cache opted into
 * rendezvous) beacons, look for other opted-in living caches co-located and recently heard, and record
 * a mutual meeting. Deliberately separate from the verified-find tiers (verify.ts): a rendezvous is a
 * social record, never points/leaderboard credit, so two stations parking together can't farm finds.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { haversineMeters } from "@aprscaching/aprs";

const RADIUS_M = 150; // how close two living caches must be to "meet"
const HEARD_WINDOW = 900; // both must have beaconed within this many seconds (15 min)
const DEDUP_WINDOW = 3600; // don't re-log the same pair within an hour

interface LivingRow {
  id: number;
  station_call: string;
  lat: number | null;
  lon: number | null;
}

/**
 * Best-effort: record rendezvous for any just-heard living cache. Never throws into the ingest path.
 * It runs on every ingest batch, so it reads the opted-in living caches once, through their partial index,
 * with each one's station joined on the stations primary key (station keys are upper-case), and matches the
 * batch's sources against them in memory: most batches hold none of their stations.
 */
export async function recordRendezvous(env: Env, heard: { src: string; lat: number; lon: number }[]): Promise<void> {
  if (!heard.length) return;
  const now = nowS();
  const living = (
    await env.DB.prepare(
      `SELECT c.id, c.station_call, s.lat, s.lon, s.last_seen AS lastSeen
         FROM caches c LEFT JOIN stations s ON s.callsign = UPPER(c.station_call)
        WHERE c.type='aprs_living' AND c.rendezvous=1 AND c.status='active' AND c.removed_at IS NULL
          AND c.station_call IS NOT NULL
        ORDER BY c.id`,
    ).all<LivingRow & { lastSeen: number | null }>()
  ).results;
  if (!living.length) return;
  const byCall = new Map<string, LivingRow>();
  for (const l of living) {
    const call = l.station_call.toUpperCase();
    if (!byCall.has(call)) byCall.set(call, l);
  }

  for (const h of heard) {
    const src = h.src.toUpperCase();
    const me = byCall.get(src);
    if (!me) continue;

    // other opted-in living caches whose station was heard recently, with a current position
    const others = living.filter(
      (o) =>
        o.station_call.toUpperCase() !== src &&
        o.lastSeen != null &&
        o.lastSeen >= now - HEARD_WINDOW &&
        o.lat != null &&
        o.lon != null,
    );

    for (const o of others) {
      if (o.lat == null || o.lon == null) continue;
      if (haversineMeters(h.lat, h.lon, o.lat, o.lon) > RADIUS_M) continue;
      // dedup: skip if this unordered pair already met within the dedup window
      const recent = await env.DB.prepare(
        `SELECT 1 AS x FROM rendezvous_log
          WHERE ts >= ? AND ((cache_a=? AND cache_b=?) OR (cache_a=? AND cache_b=?)) LIMIT 1`,
      )
        .bind(now - DEDUP_WINDOW, me.id, o.id, o.id, me.id)
        .first();
      if (recent) continue;
      await env.DB.prepare(
        "INSERT INTO rendezvous_log (cache_a, cache_b, call_a, call_b, ts, lat, lon) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(me.id, o.id, me.station_call.toUpperCase(), o.station_call.toUpperCase(), now, h.lat, h.lon)
        .run();
    }
  }
}

interface RendezvousEntry {
  withCacheId: number;
  withCall: string;
  ts: number;
  lat: number | null;
  lon: number | null;
}

/** Recent meetings for a cache (either side of the pair), newest first. */
export async function rendezvousFor(env: Env, cacheId: number, limit = 10): Promise<RendezvousEntry[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT ts, lat, lon,
            CASE WHEN cache_a=? THEN cache_b ELSE cache_a END AS withCacheId,
            CASE WHEN cache_a=? THEN call_b ELSE call_a END AS withCall
       FROM rendezvous_log WHERE cache_a=? OR cache_b=? ORDER BY ts DESC LIMIT ?`,
    )
      .bind(cacheId, cacheId, cacheId, cacheId, limit)
      .all<RendezvousEntry>()
  ).results;
  return rows;
}
