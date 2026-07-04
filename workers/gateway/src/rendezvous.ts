// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * rendezvous.ts — living-cache rendezvous. When a living cache (an aprs_living cache opted into
 * rendezvous) beacons, look for other opted-in living caches co-located and recently heard, and record
 * a mutual meeting. Deliberately separate from the verified-find tiers (verify.ts): a rendezvous is a
 * social record, never points/leaderboard credit, so two stations parking together can't farm finds.
 */
import type { Env } from "./env.js";
import { haversineMeters } from "@aprsweb/aprs";

const RADIUS_M = 150; // how close two living caches must be to "meet"
const HEARD_WINDOW = 900; // both must have beaconed within this many seconds (15 min)
const DEDUP_WINDOW = 3600; // don't re-log the same pair within an hour

interface LivingRow {
  id: number;
  station_call: string;
  lat: number | null;
  lon: number | null;
}

/** Best-effort: record rendezvous for any just-heard living cache. Never throws into the ingest path. */
export async function recordRendezvous(env: Env, heard: { src: string; lat: number; lon: number }[]): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  for (const h of heard) {
    const me = await env.DB.prepare(
      "SELECT id, station_call, lat, lon FROM caches WHERE type='aprs_living' AND rendezvous=1 AND UPPER(station_call)=UPPER(?)",
    )
      .bind(h.src)
      .first<LivingRow>();
    if (!me) continue;

    // other opted-in living caches whose station was heard recently, with a current position
    const others = (
      await env.DB.prepare(
        `SELECT c.id, c.station_call, s.lat, s.lon, s.last_seen AS lastSeen
         FROM caches c JOIN stations s ON UPPER(s.callsign)=UPPER(c.station_call)
        WHERE c.type='aprs_living' AND c.rendezvous=1 AND UPPER(c.station_call)<>UPPER(?)
          AND s.last_seen >= ? AND s.lat IS NOT NULL AND s.lon IS NOT NULL`,
      )
        .bind(h.src, nowS - HEARD_WINDOW)
        .all<LivingRow & { lastSeen: number }>()
    ).results;

    for (const o of others) {
      if (o.lat == null || o.lon == null) continue;
      if (haversineMeters(h.lat, h.lon, o.lat, o.lon) > RADIUS_M) continue;
      // dedup: skip if this unordered pair already met within the dedup window
      const recent = await env.DB.prepare(
        `SELECT 1 AS x FROM rendezvous_log
          WHERE ts >= ? AND ((cache_a=? AND cache_b=?) OR (cache_a=? AND cache_b=?)) LIMIT 1`,
      )
        .bind(nowS - DEDUP_WINDOW, me.id, o.id, o.id, me.id)
        .first();
      if (recent) continue;
      await env.DB.prepare(
        "INSERT INTO rendezvous_log (cache_a, cache_b, call_a, call_b, ts, lat, lon) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(me.id, o.id, me.station_call.toUpperCase(), o.station_call.toUpperCase(), nowS, h.lat, h.lon)
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
