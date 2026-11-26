// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * track.ts — the fixes a find is judged by: the logger's track over every SSID of their base call, and a living
 * cache's station, read in rows that stay bounded however many fixes fill the window.
 *
 * A session logs under any SSID of its own base call, so the track it is judged against cannot be the logged call
 * alone: under an SSID with no other fixes nothing would be left to contradict a beacon dropped at the cache. The
 * other SSIDs' fixes contradict a match and never make one (verify.ts `loggerTrackPositions`); a far fixed station,
 * digipeater or tracker under the same base call then refuses Tier A near its beacons, and the find falls back to
 * Tier B or C.
 *
 * A fix that can contradict (verify.ts `contradicts`: attested, or from a signed browser bridge, and not a
 * commanded box beacon) decides wherever it lies in the window, so no read may stop at a row budget that a flood
 * of other fixes under the call could spend. Nor may every such fix be loaded: a signer writes as many signed fixes
 * under their own base call as they like. The database answers instead: {@link outrunBy} finds a fix that
 * contradicts one presence, and the station read marks which owner-signed fixes the attested track allows. The
 * Worker loads the newest fixes, the attested ones that can place the logger at the cache, and the one
 * contradicting fix each judged presence needs; the verify engine judges those rows as it would judge them all.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import type { PositionRow } from "./verify.js";
import type { Attestation } from "./attestedsites.js";
import { attestedSql } from "./provenance.js";

/** Fixes of any kind per call, newest first: the window of one station's beacons holds far fewer. */
export const RECENT_LIMIT = 500;
/** Attested fixes of the logged call that can place it at the cache, newest first. */
export const CANDIDATE_LIMIT = 100;
/**
 * Fixes the database returns as contradicting that the verify engine does not take as contradicting, per find. Past
 * it the presence being judged is taken as contradicted: the search never stops at such a row, and never runs
 * unbounded.
 */
export const REJECT_LIMIT = 8;

/** The haversine Earth radius, as `haversineMeters` (packages/aprs geo.ts) uses it. */
const R = 6371000;
const RAD = Math.PI / 180;

/** A number written into SQL; only finite numbers this module computed or read from the database reach it. */
function num(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`);
  return String(x);
}

/**
 * sin(x) for |x| ≤ π, its Taylor series through x^29 (within 1e-15 of `Math.sin`): SQLite's math functions are
 * an optional build, and the macOS system library the desktop binary loads may lack them.
 */
function sinSql(x: string): string {
  const x2 = `((${x}) * (${x}))`;
  let poly = "0";
  let fact = 1;
  const coef: number[] = [];
  for (let k = 0; k <= 14; k++) {
    if (k > 0) fact *= 2 * k * (2 * k + 1);
    coef.push((k % 2 ? -1 : 1) / fact);
  }
  for (let k = 14; k >= 0; k--) poly = `${num(coef[k]!)} + ${x2} * (${poly})`;
  return `((${x}) * (${poly}))`;
}

const sq = (x: string): string => `((${x}) * (${x}))`;

interface SqlPoint {
  lat: string;
  lon: string;
  ts: string;
}

/**
 * The haversine term `h` of two points (`haversineMeters` is 2R·asin(√h)), in SQL. Latitudes lie in ±90°, longitudes in
 * ±180°, so every sine's argument stays within ±π.
 */
function havSql(a: SqlPoint, b: SqlPoint): string {
  const cosLat = (lat: string) => sinSql(`${num(Math.PI / 2)} - (${lat}) * ${num(RAD)}`);
  return `(${sq(sinSql(`((${b.lat}) - (${a.lat})) * ${num(RAD / 2)}`))} + ${cosLat(a.lat)} * ${cosLat(b.lat)} * ${sq(
    sinSql(`((${b.lon}) - (${a.lon})) * ${num(RAD / 2)}`),
  )})`;
}

/**
 * True in SQL when no ground speed of `maxMps` gets from `a` to `b`, verify.ts `reachable` negated: the time gap
 * widened by `slackSec` and at least 1 s, and haversine distance / gap > maxMps, compared as h > sin²(maxMps·gap/2R).
 */
function outrunsSql(a: SqlPoint, b: SqlPoint, maxMps: number, slackSec: number): string {
  const y = `(${num(maxMps / (2 * R))} * MAX(1, ABS((${a.ts}) - (${b.ts})) + ${num(slackSec)}))`;
  return `(${y} < ${num(Math.PI / 2)} AND ${havSql(a, b)} > ${sq(sinSql(y))})`;
}

/** Every SSID of `call`'s base call, the bare base call included, as a SQL condition and its binds. */
function familySql(call: string, t: string): { sql: string; binds: string[] } {
  const base = baseCall(call.toUpperCase());
  // `BASE-` up to (not including) `BASE.`: '.' follows '-' in ASCII, so the range holds exactly the SSIDs of the
  // base call and uses the (callsign, ts) index
  return {
    sql: `(${t}.callsign = ? OR (${t}.callsign >= ? AND ${t}.callsign < ?))`,
    binds: [base, `${base}-`, `${base}.`],
  };
}

/** A fix that can contradict (verify.ts `contradicts`), as a SQL condition on alias `t`. */
function evidenceSql(a: Attestation, t: string): { sql: string; binds: string[] } {
  const att = attestedSql(a, t);
  return { sql: `(${t}.commanded = 0 AND (${t}.source = 'browser-rf' OR ${att.sql}))`, binds: att.binds };
}

const newestFirst = (a: PositionRow, b: PositionRow): number => b.ts - a.ts || b.id - a.id;

function merged(...reads: PositionRow[][]): PositionRow[] {
  const byId = new Map<number, PositionRow>();
  for (const rows of reads) for (const p of rows) byId.set(p.id, p);
  return [...byId.values()].sort(newestFirst);
}

/** The newest {@link RECENT_LIMIT} fixes of `call` in `[since, until]`, of any kind. */
async function recentOf(env: Env, call: string, since: number, until: number): Promise<PositionRow[]> {
  return (
    await env.DB.prepare(
      "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT ?",
    )
      .bind(call, since, until, RECENT_LIMIT)
      .all<PositionRow>()
  ).results;
}

/**
 * The fixes of the logged `call` in `[since, until]`, newest first: the newest {@link RECENT_LIMIT} of any kind (a
 * Tier-C match, the commanded-beacon checks), and the newest {@link CANDIDATE_LIMIT} attested ones within
 * `near.radiusM` of a fixed cache (any attested one for a living cache, `near` absent): the fixes that can make
 * Tier A, which a flood of fixes of other kinds must not push out of the read.
 */
export async function ownFixes(
  env: Env,
  call: string,
  since: number,
  until: number,
  a: Attestation,
  near?: { lat: number; lon: number; radiusM: number },
): Promise<PositionRow[]> {
  const exact = call.toUpperCase();
  const att = attestedSql(a, "p");
  const p: SqlPoint = { lat: "p.lat", lon: "p.lon", ts: "p.ts" };
  // a hair wider than the radius, so a rounding difference never drops a fix the engine would count as near
  const within = near
    ? `AND ${havSql(p, { lat: num(near.lat), lon: num(near.lon), ts: "0" })} <= ${num(
        Math.sin(Math.min(near.radiusM / (2 * R), Math.PI / 2)) ** 2 * (1 + 1e-9),
      )}`
    : "";
  const [recent, candidates] = await Promise.all([
    recentOf(env, exact, since, until),
    env.DB.prepare(
      `SELECT p.* FROM positions p WHERE p.callsign = ? AND p.ts >= ? AND p.ts <= ? AND p.commanded = 0
         AND ${att.sql} ${within} ORDER BY p.ts DESC, p.id DESC LIMIT ?`,
    )
      .bind(exact, since, until, ...att.binds, CANDIDATE_LIMIT)
      .all<PositionRow>(),
  ]);
  return merged(recent, candidates.results);
}

/**
 * A fix of any SSID of `call`'s base call in `[since, until]` that can contradict (verify.ts `contradicts`) and
 * from which no ground speed of `maxMps` reaches `at` (the time gap widened by `slackSec`), other than the fixes
 * `except`; null when there is none. One row however many fixes fill the window: the verify engine, given it,
 * refuses the presence at `at` as it would given every fix.
 */
export async function outrunBy(
  env: Env,
  call: string,
  since: number,
  until: number,
  a: Attestation,
  at: { lat: number; lon: number; ts: number },
  opts: { maxMps: number; slackSec?: number; except?: number[] },
): Promise<PositionRow | null> {
  const fam = familySql(call, "p");
  const ev = evidenceSql(a, "p");
  const outruns = outrunsSql(
    { lat: "p.lat", lon: "p.lon", ts: "p.ts" },
    { lat: num(at.lat), lon: num(at.lon), ts: num(at.ts) },
    opts.maxMps,
    opts.slackSec ?? 0,
  );
  return (
    (await env.DB.prepare(
      `SELECT p.* FROM positions p WHERE ${fam.sql} AND p.ts >= ? AND p.ts <= ?
         AND p.id NOT IN (SELECT value FROM json_each(?)) AND ${ev.sql}
         AND ${outruns} LIMIT 1`,
    )
      .bind(...fam.binds, since, until, JSON.stringify(opts.except ?? []), ...ev.binds)
      .first<PositionRow>()) ?? null
  );
}

/**
 * The fix that contradicts the presence at `at`, as the verify engine judges it: {@link outrunBy}'s answer when
 * `refutes` (the engine, given that fix) agrees. A fix the engine does not take as contradicting is set aside and
 * the database asked again, so such a row never hides one behind it; `budget` counts those rows across one find,
 * and once it is spent the presence is `unresolved`, which a caller takes as contradicted.
 */
export async function contradictionOf(
  env: Env,
  call: string,
  since: number,
  until: number,
  a: Attestation,
  at: { lat: number; lon: number; ts: number },
  opts: { maxMps: number; slackSec?: number; except?: number[] },
  refutes: (fix: PositionRow) => boolean,
  budget: { rejected: number },
): Promise<{ fix: PositionRow | null; unresolved: boolean }> {
  const except = [...(opts.except ?? [])];
  for (;;) {
    const fix = await outrunBy(env, call, since, until, a, at, { ...opts, except });
    if (!fix) return { fix: null, unresolved: false };
    if (refutes(fix)) return { fix, unresolved: false };
    if (++budget.rejected > REJECT_LIMIT) return { fix: null, unresolved: true };
    except.push(fix.id);
  }
}

/** Whether the logged `call` has a fix in `[since, until]` that matched a beacon this instance asked a box to send. */
export async function commandedIn(env: Env, call: string, since: number, until: number): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT 1 AS x FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? AND commanded = 1 LIMIT 1",
  )
    .bind(call.toUpperCase(), since, until)
    .first());
}

/**
 * A living cache's station fixes in `[since, until]`, newest first: the newest {@link RECENT_LIMIT} of any kind,
 * and the newest {@link RECENT_LIMIT} that place the cache (verify.ts `stationEvidence`): attested ones, and, when
 * `ownerSigned`, the owner's signed `browser-rf` ones every attested fix in the window could reach. `placed` holds
 * the ids of the owner-signed fixes that qualify, judged in the database against every attested fix, so an
 * attested fix a flood pushed out of the read still refuses the owner-signed fixes it contradicts.
 */
export async function stationFixes(
  env: Env,
  call: string,
  since: number,
  until: number,
  a: Attestation,
  ownerSigned: boolean,
  maxMps: number,
): Promise<{ fixes: PositionRow[]; placed: Set<number> }> {
  const c = attestedSql(a, "c");
  const s = attestedSql(a, "s");
  const allowed = `(c.source = 'browser-rf' AND NOT EXISTS (
      SELECT 1 FROM positions s WHERE s.callsign = c.callsign AND s.ts >= ? AND s.ts <= ? AND s.commanded = 0
        AND ${s.sql} AND ${outrunsSql({ lat: "s.lat", lon: "s.lon", ts: "s.ts" }, { lat: "c.lat", lon: "c.lon", ts: "c.ts" }, maxMps, 0)}))`;
  const [recent, placing] = await Promise.all([
    recentOf(env, call, since, until),
    env.DB.prepare(
      `SELECT c.*, ${ownerSigned ? allowed : "0"} AS placed_by_owner FROM positions c
        WHERE c.callsign = ? AND c.ts >= ? AND c.ts <= ? AND c.commanded = 0
          AND (${c.sql} OR ${ownerSigned ? allowed : "0"})
        ORDER BY c.ts DESC, c.id DESC LIMIT ?`,
    )
      .bind(
        ...(ownerSigned ? [since, until, ...s.binds] : []),
        call,
        since,
        until,
        ...c.binds,
        ...(ownerSigned ? [since, until, ...s.binds] : []),
        RECENT_LIMIT,
      )
      .all<PositionRow & { placed_by_owner: number }>(),
  ]);
  const placed = new Set(placing.results.filter((p) => p.placed_by_owner).map((p) => p.id));
  const rows = placing.results.map(({ placed_by_owner: _, ...p }) => p);
  return { fixes: merged(recent, rows), placed };
}
