// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * downsample.ts — which position fixes the ingest persists.
 *
 * A busy APRS-IS feed repeats the same stationary beacons all day, and on D1 every stored fix costs
 * written rows. The ingest therefore stores a station's fix only when it says something new: the
 * station has moved at least POS_MIN_MOVE_M since its last stored fix, or POS_MIN_INTERVAL_S has
 * passed. Persistence is all this decides — every fix still reaches the live map, watch alerts,
 * rendezvous and BBS delivery.
 *
 * Verification never loses a fix to this. A fix is always stored when verification may read it:
 * when it was heard directly on RF (the corroboration answerer and Tier A read those for any callsign),
 * or when its station is protected ({@link protectedStations}).
 */
import { haversineMeters } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { DEFAULT_POLICY } from "./verify.js";

/** Store a fix once the station has moved this far (metres) since its last stored fix. */
export const POS_MIN_MOVE_M_DEFAULT = 25;
/** Store a fix once this long (seconds) has passed since the station's last stored fix. */
export const POS_MIN_INTERVAL_S_DEFAULT = 600;

export interface DownsamplePolicy {
  /** false ⇒ every fix is stored */
  enabled: boolean;
  moveM: number;
  intervalS: number;
}

const setting = (raw: string | undefined, dflt: number): number => {
  if (raw == null || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** The thresholds in force. `0` in either one stores every fix: a zero distance or interval is always reached. */
export function downsamplePolicy(env: Env): DownsamplePolicy {
  const moveM = setting(env.POS_MIN_MOVE_M, POS_MIN_MOVE_M_DEFAULT);
  const intervalS = setting(env.POS_MIN_INTERVAL_S, POS_MIN_INTERVAL_S_DEFAULT);
  return { enabled: moveM > 0 && intervalS > 0, moveM, intervalS };
}

/**
 * How long `stations.last_seen` can trail a station's latest beacon: a stationary, unprotected station's
 * beacons refresh it once per interval. Readers that judge liveness by `last_seen` allow for it.
 */
export function lastSeenLagS(env: Env): number {
  const p = downsamplePolicy(env);
  return p.enabled ? p.intervalS : 0;
}

/** Ingest transports whose frames the operator's own receiver heard (see provenance.ts). */
const DIRECT_HEARING = new Set(["tnc", "meshcom"]);

/**
 * A fix heard directly on RF: `heard_via = 'rf'`, or carried by a direct-hearing port (a TNC or MeshCom
 * node on the ingest box). Always stored, whatever the callsign: Tier A and the corroboration answers
 * this instance gives its peers read these rows for any callsign, account or not. RF volume is small
 * next to APRS-IS, so keeping all of it costs little.
 */
export function heardDirectly(heardVia: string, transport: string): boolean {
  return heardVia === "rf" || DIRECT_HEARING.has(transport);
}

/** A station's last stored fix. */
export interface StoredFix {
  lat: number;
  lon: number;
  ts: number;
}

/** Whether a fix says something new against the station's last stored fix. No stored fix ⇒ it does. */
export function worthStoring(
  last: StoredFix | undefined,
  fix: { lat: number; lon: number; ts: number },
  policy: DownsamplePolicy,
): boolean {
  if (!policy.enabled || !last) return true;
  if (fix.ts - last.ts >= policy.intervalS) return true;
  return haversineMeters(last.lat, last.lon, fix.lat, fix.lon) >= policy.moveM;
}

/** The last stored fix of each callsign, from `stations`, in one read. */
export async function lastStoredFixes(env: Env, callsigns: string[]): Promise<Map<string, StoredFix>> {
  const out = new Map<string, StoredFix>();
  if (!callsigns.length) return out;
  const rows = (
    await env.DB.prepare(
      `SELECT callsign, lat, lon, last_seen FROM stations
        WHERE callsign IN (SELECT value FROM json_each(?)) AND lat IS NOT NULL AND lon IS NOT NULL AND last_seen IS NOT NULL`,
    )
      .bind(JSON.stringify(callsigns))
      .all<{ callsign: string; lat: number; lon: number; last_seen: number }>()
  ).results;
  for (const r of rows) out.set(r.callsign, { lat: r.lat, lon: r.lon, ts: r.last_seen });
  return out;
}

/** `col` is the base call `b.base` itself or one of its SSIDs (`BASE-…`), as an index range. */
const ofBase = (col: string) => `(${col} = b.base OR (${col} > b.base || '-' AND ${col} < b.base || '.'))`;

/**
 * The base calls among `bases` whose every fix is stored, in one read. A base call is protected when:
 *
 *  (a) an account holds it, or it is control-verified (`account_callsigns`, `callsign_verifications`) —
 *      a logger's finds read their own positions, under any SSID;
 *  (b) it, or one of its SSIDs, is a registered station (`account_stations`) — its account's finds
 *      and its registry location follow its fixes;
 *  (c) it has a find open: one of its SSIDs logged a find (`cache_logs`), or sent a radio command
 *      (`radio_commands`), within the verification window before `now` (`DEFAULT_POLICY.windowSec`,
 *      the span `scoreFind` reads positions over), or has a radio command still pending or being
 *      confirmed — a logger in the middle of a cache run keeps every fix the next find will read;
 *  (d) it, or one of its SSIDs, is the station of a living cache — a living find reads the station's
 *      positions over the same window.
 *
 * Directly heard RF fixes are stored whatever their callsign ({@link heardDirectly}); that is a
 * property of the fix, not of the station, so it is not decided here.
 */
export async function protectedStations(env: Env, bases: string[], now: number): Promise<Set<string>> {
  if (!bases.length) return new Set();
  const since = now - DEFAULT_POLICY.windowSec;
  const rows = (
    await env.DB.prepare(
      `WITH b(base) AS (SELECT DISTINCT value FROM json_each(?)),
            living(call) AS MATERIALIZED (
              SELECT DISTINCT UPPER(station_call) FROM caches WHERE type = 'aprs_living' AND station_call IS NOT NULL)
       SELECT b.base AS base FROM b WHERE
            EXISTS (SELECT 1 FROM account_callsigns a WHERE a.callsign = b.base)
         OR EXISTS (SELECT 1 FROM callsign_verifications v WHERE v.callsign = b.base AND v.status = 'verified')
         OR EXISTS (SELECT 1 FROM account_stations s WHERE ${ofBase("s.callsign")})
         OR EXISTS (SELECT 1 FROM cache_logs l WHERE ${ofBase("l.logger_call")} AND l.ts >= ?)
         OR EXISTS (SELECT 1 FROM radio_commands r WHERE ${ofBase("r.from_call")}
                      AND (r.status IN ('pending', 'confirming') OR r.sent_at >= ?))
         OR EXISTS (SELECT 1 FROM living WHERE ${ofBase("living.call")})`,
    )
      .bind(JSON.stringify(bases), since, since)
      .all<{ base: string }>()
  ).results;
  return new Set(rows.map((r) => r.base));
}

/** Whether every fix of `baseCall` is stored ({@link protectedStations}); one base call, one read. */
export async function isProtectedStation(env: Env, baseCall: string, now: number): Promise<boolean> {
  return (await protectedStations(env, [baseCall], now)).has(baseCall);
}
