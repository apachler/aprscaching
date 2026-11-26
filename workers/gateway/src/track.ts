// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * track.ts — the fixes a find is judged by: the logger's track over every SSID of their base call, and a living
 * cache's station.
 *
 * A session logs under any SSID of its own base call, so the track it is judged against cannot be the logged call
 * alone: under an SSID with no other fixes nothing would be left to contradict a beacon dropped at the cache. The
 * other SSIDs' fixes contradict a match and never make one (verify.ts `loggerTrackPositions`); a far fixed station,
 * digipeater or tracker under the same base call then refuses Tier A near its beacons, and the find falls back to
 * Tier B or C.
 *
 * Every fix that can be evidence (heard on the air or from a signed browser bridge, and not a commanded box
 * beacon: the only kinds that can be attested or contradict, verify.ts `contradicts`) is read without a row cap. A
 * cap is a budget anyone filling the window with fixes under the call could spend, pushing an attested
 * contradiction out of the read. The capped read beside it carries the newest fixes of any kind, for a Tier-C
 * match and the commanded-beacon checks.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import type { PositionRow } from "./verify.js";

/** Fixes of any kind per call, newest first: the window of one station's beacons holds far fewer. */
const RECENT_LIMIT = 500;

/**
 * A fix that can be evidence, not a commanded beacon: heard on the air (only that can be attested), or from a
 * signed browser bridge (verify.ts `contradicts`, whatever the batch says it was heard over).
 */
const EVIDENCE = "commanded = 0 AND (heard_via = 'rf' OR source = 'browser-rf')";

const newestFirst = (a: PositionRow, b: PositionRow): number => b.ts - a.ts || b.id - a.id;

/**
 * The fixes of `call` in `[since, until]`, newest first: every fix that can be evidence, and the newest
 * {@link RECENT_LIMIT} of any kind.
 */
export async function fixesOf(env: Env, call: string, since: number, until: number): Promise<PositionRow[]> {
  const [evidence, recent] = await Promise.all([
    env.DB.prepare(`SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? AND ${EVIDENCE}`)
      .bind(call, since, until)
      .all<PositionRow>(),
    env.DB.prepare("SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?")
      .bind(call, since, until, RECENT_LIMIT)
      .all<PositionRow>(),
  ]);
  const byId = new Map<number, PositionRow>();
  for (const p of [...evidence.results, ...recent.results]) byId.set(p.id, p);
  return [...byId.values()].sort(newestFirst);
}

/**
 * The fixes in `[since, until]` of `call` (`own`, the only ones that can match) and the evidence fixes of every
 * other SSID of its base call, the bare base call included (`others`, which only contradict).
 */
export async function loggerTrack(
  env: Env,
  call: string,
  since: number,
  until: number,
): Promise<{ own: PositionRow[]; others: PositionRow[] }> {
  const exact = call.toUpperCase();
  const base = baseCall(exact);
  // `BASE-` up to (not including) `BASE.`: '.' follows '-' in ASCII, so the range holds exactly the SSIDs of the
  // base call and uses the (callsign, ts) index
  const [own, others] = await Promise.all([
    fixesOf(env, exact, since, until),
    env.DB.prepare(
      `SELECT * FROM positions WHERE (callsign = ? OR (callsign >= ? AND callsign < ?)) AND callsign <> ?
         AND ts >= ? AND ts <= ? AND ${EVIDENCE} ORDER BY ts DESC`,
    )
      .bind(base, `${base}-`, `${base}.`, exact, since, until)
      .all<PositionRow>(),
  ]);
  return { own, others: others.results };
}
