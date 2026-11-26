// SPDX-License-Identifier: AGPL-3.0-or-later
// stationFixes judges each owner-signed fix against each attested position's time-nearest fixes only. Its answer
// must be the direct judgement's, which asks every attested fix in the window about every signed fix: the two are
// compared here over generated worlds that hold ties, empty and inverted windows, stations with no attested fix,
// refusing fixes at either end of the window and reads past the row limit.
import { describe, it, expect } from "vitest";
import { RECENT_LIMIT, outrunsSql, stationFixes } from "@aprscaching/gateway/track";
import { attestedSql } from "@aprscaching/gateway/provenance";
import type { Attestation } from "@aprscaching/gateway/attestedsites";
import type { PositionRow } from "@aprscaching/gateway/verify";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv } from "./helpers/authflow.js";

const SITE = "OE8XXX-10";
const BOX_SITE = "OE8BOX-10";
const CALL = "OE8OWN-9";
const T0 = 1_000_000;

/** The placing read with every signed fix judged against every attested fix in the window. */
async function directJudgement(
  env: Env,
  call: string,
  since: number,
  until: number,
  a: Attestation,
  ownerSigned: boolean,
  maxMps: number,
): Promise<{ fixes: PositionRow[]; placed: Set<number>; placing: number }> {
  const c = attestedSql(a, "c");
  const s = attestedSql(a, "s");
  const allowed = `(c.source = 'browser-rf' AND NOT EXISTS (
      SELECT 1 FROM positions s WHERE s.callsign = c.callsign AND s.ts >= ? AND s.ts <= ? AND s.commanded = 0
        AND ${s.sql} AND ${outrunsSql({ lat: "s.lat", lon: "s.lon", ts: "s.ts" }, { lat: "c.lat", lon: "c.lon", ts: "c.ts" }, maxMps, 0)}))`;
  const judged = ownerSigned ? [since, until, ...s.binds] : [];
  const placing = (
    await env.DB.prepare(
      `SELECT c.*, ${ownerSigned ? allowed : "0"} AS placed_by_owner FROM positions c
        WHERE c.callsign = ? AND c.ts >= ? AND c.ts <= ? AND c.commanded = 0
          AND (${c.sql} OR ${ownerSigned ? allowed : "0"})
        ORDER BY c.ts DESC, c.id DESC LIMIT ?`,
    )
      .bind(...judged, call, since, until, ...c.binds, ...judged, RECENT_LIMIT)
      .all<PositionRow & { placed_by_owner: number }>()
  ).results;
  const recent = (
    await env.DB.prepare(
      "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT ?",
    )
      .bind(call, since, until, RECENT_LIMIT)
      .all<PositionRow>()
  ).results;
  const byId = new Map<number, PositionRow>();
  for (const p of [...recent, ...placing.map(({ placed_by_owner: _, ...p }) => p as PositionRow)]) byId.set(p.id, p);
  const fixes = [...byId.values()].sort((x, y) => y.ts - x.ts || y.id - x.id);
  return { fixes, placed: new Set(placing.filter((p) => p.placed_by_owner).map((p) => p.id)), placing: placing.length };
}

/** A seeded generator (mulberry32), so a failing world is named by its seed. */
function generator(seed: number) {
  let t = seed >>> 0;
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  return { next, pick };
}

interface World {
  call: string;
  since: number;
  until: number;
  a: Attestation;
  ownerSigned: boolean;
  maxMps: number;
}

/**
 * Fills a fresh database with one world: a few fixed spots the station's attested fixes repeat, so a spot holds many
 * fixes at tied and spread times, beside stray positions, other calls, commanded beacons and signed fixes near and
 * far; some worlds hold more rows than one read returns.
 */
async function world(env: Env, seed: number): Promise<World> {
  const { next, pick } = generator(seed);
  // spots are drawn from a few latitudes and a few longitudes, so two spots often share one coordinate and differ
  // in the other: only the whole position makes fixes interchangeable
  const lats = Array.from(
    { length: 1 + Math.floor(next() * 3) },
    () => 47 + pick([0, 0, 1e-4, 0.01, 0.1, 1, -1]) * next(),
  );
  const lons = Array.from({ length: 1 + Math.floor(next() * 3) }, () => 15 + pick([0, 0, 1e-4, 0.01, 0.5, 3]) * next());
  const spots = Array.from({ length: 1 + Math.floor(next() * 4) }, () => [pick(lats), pick(lons)]);
  const place = (): [number, number] =>
    next() < 0.7
      ? (pick(spots) as [number, number])
      : [47 + pick([0, 1e-4, 0.01, 0.1, 1, 5]) * next(), 15 + pick([0, 1e-4, 0.01, 0.5, 3]) * next()];
  // every 25th world holds more of the station's fixes in a wide window than one read returns
  const big = seed % 25 === 0;
  const n = big ? 1500 : Math.floor(next() * 60);
  const rows: unknown[][] = [];
  for (let i = 0; i < n; i++) {
    const signed = next() < 0.5;
    const [lat, lon] = place();
    rows.push([
      big ? CALL : pick([CALL, CALL, CALL, CALL, "oe8own-9", "OE8OWN", "OE8OWN-10"]),
      T0 + Math.floor(next() * 40) * pick([1, 1, 5, 30]),
      lat,
      lon,
      pick(["rf", "rf", "rf", "rf", "aprs_is"]),
      signed ? pick(["browser-rf", "browser-rf", "tnc"]) : pick(["tnc", "tnc", "tnc", "meshcom", "aprs-is"]),
      signed ? pick([null, "", SITE]) : pick([SITE, SITE, SITE, BOX_SITE, "oe8xxx-10", "", null, "OE8ZZZ-1"]),
      pick(["WIDE1-1", "WIDE1-1", "WIDE1-1,qAR,OE8XXX-10", "qAO,X", "qAC,X", null]),
      signed ? pick(["browser-rf", "browser-rf", "BROWSER-RF", null]) : pick(["firehose", "browser-rf", null]),
      pick([null, null, "", "box-1", "box-2"]),
      pick([0, 0, 0, 0, 0, 1]),
    ]);
  }
  for (let i = 0; i < rows.length; i += 50) {
    const part = rows.slice(i, i + 50);
    await env.DB.prepare(
      `INSERT INTO positions (callsign, ts, lat, lon, heard_via, transport, igate_call, path, source, ingest_box, commanded)
       VALUES ${part.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",")}`,
    )
      .bind(...part.flat())
      .run();
  }
  const since = big ? T0 : T0 + pick([-10, 0, 0, 5, 20, 39]);
  const w: World = {
    call: big ? CALL : pick([CALL, CALL, CALL, "oe8own-9", "OE8OWN"]),
    since,
    until: since + (big ? 2000 : pick([-1, 0, 1, 10, 40, 40, 2000])),
    a: pick([
      { shared: new Set([SITE]), byBox: new Map() },
      { shared: new Set([SITE]), byBox: new Map([["box-1", new Set([BOX_SITE])]]) },
      { shared: new Set<string>(), byBox: new Map() },
    ]),
    ownerSigned: next() < 0.85,
    // 0 refuses any move at all, so a signed fix at an attested fix's own position sits exactly on the bound
    maxMps: pick([0, 0.001, 1, 50, 300, 3000, 1e7]),
  };
  // an attested fix far from every spot on either end of the window, where an off-by-one bound would drop it
  for (const ts of [w.since, w.until])
    if (next() < 0.3)
      await env.DB.prepare(
        `INSERT INTO positions (callsign, ts, lat, lon, heard_via, transport, igate_call, path, source)
         VALUES (?, ?, ?, 15, 'rf', 'tnc', ?, 'WIDE1-1', 'firehose')`,
      )
        .bind(w.call, ts, 47 + pick([0.01, 0.1, 1, 5]), SITE)
        .run();
  return w;
}

describe("the station read's judgement of owner-signed fixes", () => {
  it("is the direct judgement's, over generated worlds", async () => {
    const seeds = Number(process.env.JUDGE_WORLDS ?? 400);
    const seen = { placed: 0, refused: 0, limit: 0, noAttested: 0 };
    for (let seed = 1; seed <= seeds; seed++) {
      const env = authEnv();
      const w = await world(env, seed);
      const want = await directJudgement(env, w.call, w.since, w.until, w.a, w.ownerSigned, w.maxMps);
      const got = await stationFixes(env, w.call, w.since, w.until, w.a, w.ownerSigned, w.maxMps);
      expect({ seed, fixes: got.fixes.map((p) => p.id) }).toEqual({ seed, fixes: want.fixes.map((p) => p.id) });
      expect({ seed, fixes: got.fixes }).toEqual({ seed, fixes: want.fixes });
      expect({ seed, placed: [...got.placed].sort() }).toEqual({ seed, placed: [...want.placed].sort() });
      const signed = want.fixes.filter((p) => p.source === "browser-rf" && !p.commanded).length;
      seen.placed += want.placed.size;
      seen.refused += w.ownerSigned ? signed - want.placed.size : 0;
      if (want.placing >= RECENT_LIMIT) seen.limit++;
      const att = attestedSql(w.a, "s");
      const anyAttested = await env.DB.prepare(
        `SELECT 1 AS x FROM positions s WHERE s.callsign = ? AND s.ts >= ? AND s.ts <= ? AND ${att.sql} LIMIT 1`,
      )
        .bind(w.call, w.since, w.until, ...att.binds)
        .first();
      if (w.ownerSigned && !anyAttested) seen.noAttested++;
    }
    // each side of the judgement occurred, so the comparison saw both answers and the edges it is meant to cover
    expect(seen.placed).toBeGreaterThan(0);
    expect(seen.refused).toBeGreaterThan(0);
    expect(seen.limit).toBeGreaterThan(0);
    expect(seen.noAttested).toBeGreaterThan(0);
  });
});
