// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * track.ts — the logger's track for the plausible-track check: every SSID of their base call.
 *
 * A session logs under any SSID of its own base call, so the track it is judged against cannot be the logged call
 * alone: under an SSID with no other fixes nothing would be left to contradict a beacon dropped at the cache. The
 * other SSIDs' fixes contradict a match and never make one (verify.ts `loggerTrackPositions`); a far fixed station,
 * digipeater or tracker under the same base call then refuses Tier A near its beacons, and the find falls back to
 * Tier B or C.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import type { PositionRow } from "./verify.js";

/** Fixes per query, newest first: a window holds far fewer from one station. */
const TRACK_LIMIT = 500;

export interface LoggerTrack {
  /** the logged call's own fixes — the only ones that can match */
  own: PositionRow[];
  /** the fixes of every other SSID of the base call, the bare base call included */
  others: PositionRow[];
}

/** The fixes in `[since, until]` of `call` and of every other SSID of its base call. */
export async function loggerTrack(env: Env, call: string, since: number, until: number): Promise<LoggerTrack> {
  const exact = call.toUpperCase();
  const base = baseCall(exact);
  const own = await env.DB.prepare(
    "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?",
  )
    .bind(exact, since, until, TRACK_LIMIT)
    .all<PositionRow>();
  // `BASE-` up to (not including) `BASE.`: '.' follows '-' in ASCII, so the range holds exactly the SSIDs of the
  // base call and uses the (callsign, ts) index
  const others = await env.DB.prepare(
    `SELECT * FROM positions WHERE (callsign = ? OR (callsign >= ? AND callsign < ?)) AND callsign <> ?
       AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
  )
    .bind(base, `${base}-`, `${base}.`, exact, since, until, TRACK_LIMIT)
    .all<PositionRow>();
  return { own: own.results, others: others.results };
}
