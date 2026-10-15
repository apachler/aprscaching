// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * coverage.ts — where radio hears a finder, for the hide form's map: `GET /api/v1/coverage?bbox=`.
 *
 * Two kinds of receiver answer, each with a range circle:
 *   - the attested receiving sites (attestedsites.ts): a frame one of them hears is what makes a find Tier A;
 *   - the digipeaters and IGates heard on the air lately: a frame they carry reaches this instance over
 *     APRS-IS, which stays Tier C unless an attested site hears it too (provenance.ts).
 * A station is a digipeater or an IGate by its APRS symbol (`#` a digipeater, `&` a gateway), by the roles its
 * operator gave it under My stations, or because it gated a stored position lately (`stations.source_call`).
 *
 * The range is the one the station advertises (PHG or RNG, `stations.range_km`), capped at COVERAGE_MAX_KM; a
 * station that advertises none gets the conservative default for its kind, marked `estimated`. Positions are the
 * ones the stations beaconed on the air, which every APRS map already shows; a registry entry's own location is
 * never used, so a station its operator never beaconed stays off the map. No owner or account is named.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { attestedSites } from "./attestedsites.js";
import {
  COVERAGE_DEFAULT_KM,
  COVERAGE_MAX_KM,
  COVERAGE_MAX_SITES,
  type CoverageKind,
  type CoverageResponse,
  type CoverageSite,
} from "@aprscaching/shared";

/** A digipeater or IGate counts as heard lately when it sent a position within this window. */
const INFRA_WINDOW_S = 7 * 86400;
/** An attested site counts while its last position is this recent: a receiving site beacons seldom. */
const ATTESTED_WINDOW_S = 30 * 86400;

interface Row {
  callsign: string;
  lat: number;
  lon: number;
  symbol: string | null;
  range_km: number | null;
  last_seen: number;
  roles: string | null;
}

/** The roles csv of a registry entry, as a set. */
const rolesOf = (csv: string | null): Set<string> => new Set((csv ?? "").split(",").map((s) => s.trim()));

/** A digipeater by its symbol (`/#`, or `#` under an overlay) or its registry roles. */
export function isDigipeater(symbol: string | null, roles: string | null): boolean {
  return symbol?.[1] === "#" || rolesOf(roles).has("digipeater");
}

/**
 * Pure: the circle to draw for a station. A range it advertises (more than zero) is drawn as sent, up to
 * COVERAGE_MAX_KM; none gets the default for a digipeater or for any other receiver, marked estimated.
 */
export function coverageRange(rangeKm: number | null, digipeater: boolean): { rangeKm: number; estimated: boolean } {
  if (rangeKm != null && Number.isFinite(rangeKm) && rangeKm > 0)
    return { rangeKm: Math.min(rangeKm, COVERAGE_MAX_KM), estimated: false };
  return { rangeKm: digipeater ? COVERAGE_DEFAULT_KM.digipeater : COVERAGE_DEFAULT_KM.receiver, estimated: true };
}

function site(r: Row, kind: CoverageKind): CoverageSite {
  return {
    callsign: r.callsign,
    lat: r.lat,
    lon: r.lon,
    kind,
    ...coverageRange(r.range_km, isDigipeater(r.symbol, r.roles)),
    lastSeen: r.last_seen,
  };
}

/** The bbox as minLon,minLat,maxLon,maxLat, or null when absent or malformed (readapi.ts caps its size). */
function parseBBox(u: URL): [number, number, number, number] | null {
  const p = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite)) return null;
  return p as [number, number, number, number];
}

export async function handleCoverage(req: Request, env: Env): Promise<Response> {
  const bb = parseBBox(new URL(req.url));
  if (!bb) return json({ error: "bbox=minLon,minLat,maxLon,maxLat is required" }, { status: 400 });
  const [minLon, minLat, maxLon, maxLat] = bb;
  const now = nowS();
  const box = "s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?";
  const boxBinds = [minLat, maxLat, minLon, maxLon];
  const cols = "s.callsign, s.lat, s.lon, s.symbol, s.range_km, s.last_seen, a.roles";

  const attested = [...(await attestedSites(env))];
  const att = attested.length
    ? ((
        await env.DB.prepare(
          `SELECT ${cols} FROM stations s LEFT JOIN account_stations a ON a.callsign = s.callsign
            WHERE s.callsign IN (${attested.map(() => "?").join(",")}) AND s.lat IS NOT NULL AND s.last_seen >= ?
              AND ${box}
            ORDER BY s.last_seen DESC LIMIT ?`,
        )
          .bind(...attested, now - ATTESTED_WINDOW_S, ...boxBinds, COVERAGE_MAX_SITES)
          .all<Row>()
      ).results ?? [])
    : [];
  const infraSince = now - INFRA_WINDOW_S;
  const infra =
    (
      await env.DB.prepare(
        `SELECT ${cols} FROM stations s LEFT JOIN account_stations a ON a.callsign = s.callsign
          WHERE s.lat IS NOT NULL AND s.last_seen >= ? AND ${box}
            AND (substr(s.symbol, 2, 1) IN ('#', '&')
                 OR (',' || a.roles || ',') LIKE '%,digipeater,%' OR (',' || a.roles || ',') LIKE '%,igate,%'
                 OR EXISTS (SELECT 1 FROM stations g WHERE g.source_call = s.callsign AND g.last_seen >= ?))
          ORDER BY s.last_seen DESC LIMIT ?`,
      )
        .bind(infraSince, ...boxBinds, infraSince, COVERAGE_MAX_SITES + 1)
        .all<Row>()
    ).results ?? [];

  const attestedCalls = new Set(att.map((r) => r.callsign));
  const sites: CoverageSite[] = att.map((r) => site(r, "attested"));
  let truncated = infra.length > COVERAGE_MAX_SITES;
  for (const r of infra) {
    if (attestedCalls.has(r.callsign)) continue;
    if (sites.length >= COVERAGE_MAX_SITES) {
      truncated = true;
      break;
    }
    sites.push(site(r, isDigipeater(r.symbol, r.roles) ? "digipeater" : "igate"));
  }
  const body: CoverageResponse = { sites, truncated };
  return json(body, { headers: { "cache-control": "public, max-age=60" } });
}
