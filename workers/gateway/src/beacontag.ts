// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * beacontag.ts — tell a commanded box beacon from its station's own travels.
 *
 * An operator can ask their ingest box to beacon (Shack → Remote box, `box_commands` kind `beacon`). The box
 * names its own configured position, so the beacon says where the box is, not where the operator is — and an
 * attested site that hears it would otherwise turn it into Tier A evidence for a find, or a federation
 * corroboration. Every fix ingested under the beacon's call, inside its time window and near the position the
 * box reported, is stored with `positions.commanded = 1`; the verify engine, the corroboration answer and the
 * later corroboration attempt never take such a fix as evidence.
 */
import { haversineMeters } from "@aprscaching/aprs";
import type { Env } from "./env.js";

/** How long after its lease a beacon's hearings arrive: digipeated copies and APRS-IS copies take minutes. */
const BEACON_ECHO_S = 15 * 60;
/** Allowance before the lease for a hearing's own timestamp (the box's clock and the ingest's differ). */
const BEACON_SKEW_S = 60;
/** How near the position the box reported a hearing lies to be the beacon; APRS positions round to ~18 m. */
const BEACON_MATCH_M = 500;

interface CommandedBeacon {
  from: number;
  until: number;
  lat?: number;
  lon?: number;
}

/** How long a box may take to ack a beacon it sent (its acks wait while the gateway is unreachable). */
const ACK_DELAY_S = 3600;

/** The commanded beacons of `calls` (exact calls, any case) whose window may reach back to `since`, by call. */
export async function commandedBeacons(
  env: Env,
  calls: string[],
  since: number,
): Promise<Map<string, CommandedBeacon[]>> {
  const out = new Map<string, CommandedBeacon[]>();
  const wanted = [...new Set(calls.map((c) => c.toUpperCase()))];
  if (!wanted.length) return out;
  const rows = (
    await env.DB.prepare(
      `SELECT UPPER(callsign) AS callsign, payload, sent_at AS sentAt, acked_at AS ackedAt FROM box_commands
       WHERE kind = 'beacon' AND status IN ('sent', 'done') AND sent_at >= ?
         AND UPPER(callsign) IN (${wanted.map(() => "?").join(",")})`,
    )
      .bind(since - BEACON_ECHO_S - ACK_DELAY_S, ...wanted)
      .all<{ callsign: string; payload: string | null; sentAt: number; ackedAt: number | null }>()
  ).results;
  for (const r of rows) {
    let at: { lat?: unknown; lon?: unknown } = {};
    try {
      at = r.payload ? (JSON.parse(r.payload) as typeof at) : {};
    } catch {
      // an unreadable payload names no position: the beacon then matches on call and time alone
    }
    const b: CommandedBeacon = {
      from: r.sentAt - BEACON_SKEW_S,
      until: Math.max(r.sentAt, r.ackedAt ?? 0) + BEACON_ECHO_S,
      ...(typeof at.lat === "number" && typeof at.lon === "number" ? { lat: at.lat, lon: at.lon } : {}),
    };
    out.set(r.callsign, [...(out.get(r.callsign) ?? []), b]);
  }
  return out;
}

/**
 * True when a fix of `call` at `ts`, ingested at `now`, is a commanded beacon's hearing: inside a beacon's window
 * by its own time or by its arrival, and near the position the box reported (any position while the box has not
 * reported one yet).
 */
export function isCommandedBeacon(
  beacons: Map<string, CommandedBeacon[]>,
  fix: { call: string; ts: number; lat: number; lon: number },
  now: number,
): boolean {
  for (const b of beacons.get(fix.call.toUpperCase()) ?? []) {
    const inWindow = (t: number) => t >= b.from && t <= b.until;
    if (!inWindow(fix.ts) && !inWindow(now)) continue;
    if (b.lat == null || b.lon == null) return true;
    if (haversineMeters(fix.lat, fix.lon, b.lat, b.lon) <= BEACON_MATCH_M) return true;
  }
  return false;
}
