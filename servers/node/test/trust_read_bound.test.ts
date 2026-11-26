// SPDX-License-Identifier: AGPL-3.0-or-later
// The trust read of one find, through the real scoring over a migrated SQLite: the fixes it brings out of the
// database stay within a fixed number however many fixes fill the window, and a flood of them still cannot hide
// the attested fix that contradicts a match.
import { describe, it, expect } from "vitest";
import { scoreFind } from "@aprscaching/gateway/caches";
import { CANDIDATE_LIMIT, RECENT_LIMIT } from "@aprscaching/gateway/track";
import type { Env } from "@aprscaching/gateway/env";
import type { SqlDatabase, SqlStatement } from "@aprscaching/gateway/runtime";
import { authEnv } from "./helpers/authflow.js";

const SITE = "OE8XXX-10";
const LAT = 47 + 4.2 / 60;
const LON = 15 + 25.2 / 60;
const now = () => Math.floor(Date.now() / 1000);
/** Far more fixes than any read of the window may bring out of the database. */
const FLOOD = 4 * (2 * RECENT_LIMIT + CANDIDATE_LIMIT);
/** The rows a find's trust read may load: the newest fixes of the logged call and the station, the attested ones
 *  that can place the logger, and one contradicting fix per match tried and for a peer's hearing. */
const BOUND = 2 * RECENT_LIMIT + 3 * CANDIDATE_LIMIT + 1;

const room = { fetch: async () => new Response(null, { status: 204 }) };
const world = () => authEnv({ FIRST_PARTY_SITES: SITE, ROOMS: { get: () => room } });

async function account(env: Env, id: string, call: string) {
  await env.DB.prepare("INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES (?,?,1,0)")
    .bind(id, call)
    .run();
}

async function cache(env: Env, o: { type: string; stationCall?: string }) {
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, station_call, created_at, updated_at)
     VALUES (?, 'OE8OWN', 'Test', ?, ?, ?, ?, 1, 1)`,
  )
    .bind(`AC-RB${Math.random().toString(36).slice(2, 8)}`, o.type, LAT, LON, o.stationCall ?? null)
    .run();
  return (await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(Number(r.meta.last_row_id)).first()) as never;
}

/** One fix the attested site's own TNC heard, `ago` seconds back, `dLat` degrees north of the spot. */
async function attested(env: Env, call: string, o: { ago: number; dLat?: number }) {
  await env.DB.prepare(
    `INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport)
     VALUES (?,?,?,?, 'rf', ?, 'WIDE1-1', 'firehose', 'tnc')`,
  )
    .bind(call, now() - o.ago, LAT + (o.dLat ?? 0), LON, SITE)
    .run();
}

/** `n` signed browser-RF fixes of `call` at the spot, 100–199 s back: between the far fix and the match. */
async function flood(env: Env, call: string, n: number) {
  await env.DB.prepare(
    `INSERT INTO positions (callsign, ts, lat, lon, heard_via, path, source, transport)
     WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < ?)
     SELECT ?, ? - 100 - (i % 100), ?, ?, 'rf', 'WIDE1-1', 'browser-rf', 'browser-rf' FROM k`,
  )
    .bind(n, call, now(), LAT, LON)
    .run();
}

/** `env` whose database counts the `positions` rows its reads return. */
function counting(env: Env): { env: Env; rows: () => number } {
  let n = 0;
  const wrap = (s: SqlStatement, sql: string): SqlStatement => ({
    bind: (...v: unknown[]) => wrap(s.bind(...v), sql),
    run: () => s.run(),
    first: async <T>() => {
      const r = await s.first<T>();
      if (r && /\bFROM positions\b/.test(sql)) n++;
      return r;
    },
    all: async <T>() => {
      const r = await s.all<T>();
      if (/\bFROM positions\b/.test(sql)) n += r.results?.length ?? 0;
      return r;
    },
  });
  const db: SqlDatabase = {
    prepare: (sql) => wrap(env.DB.prepare(sql), sql),
    batch: (st) => env.DB.batch(st),
  };
  return { env: { ...env, DB: db }, rows: () => n };
}

describe("the trust read of one find", () => {
  for (const [name, floodCall] of [
    ["under the logged call", "OE8LOG-9"],
    ["under another SSID", "OE8LOG-15"],
  ] as const) {
    it(`loads at most ${BOUND} fixes, with ${FLOOD} signed fixes ${name}`, async () => {
      const env = world();
      const trad = await cache(env, { type: "traditional" });
      await attested(env, "OE8LOG-9", { ago: 60 });
      await flood(env, floodCall, FLOOD);
      const c = counting(env);
      expect((await scoreFind(c.env, trad, "OE8LOG-9", now())).result.tier).toBe("A");
      expect(c.rows()).toBeLessThanOrEqual(BOUND);
    });
  }

  it(`loads at most ${BOUND} fixes, with ${FLOOD} owner-signed fixes of a living cache's station`, async () => {
    const env = world();
    await account(env, "acct-own", "OE8OWN");
    const living = await cache(env, { type: "aprs_living", stationCall: "OE8OWN-9" });
    await attested(env, "OE8OWN-9", { ago: 70 });
    await attested(env, "OE8LOG-9", { ago: 60 });
    await flood(env, "OE8OWN-9", FLOOD);
    const c = counting(env);
    expect((await scoreFind(c.env, living, "OE8LOG-9", now())).result.tier).toBe("A");
    expect(c.rows()).toBeLessThanOrEqual(BOUND);
  });
});

describe(`a flood of ${FLOOD} signed fixes at the spot`, () => {
  // the attested far fix: 1° of latitude north (~111 km), 250 s back, older than every flooded fix
  for (const [name, farCall] of [
    ["under the logged call", "OE8LOG-9"],
    ["under another SSID", "OE8LOG-7"],
  ] as const) {
    it(`does not hide an attested fix ${name} that contradicts the match`, async () => {
      const tiers = [];
      for (const n of [0, FLOOD]) {
        const env = world();
        const trad = await cache(env, { type: "traditional" });
        await attested(env, farCall, { ago: 250, dLat: 1 });
        await attested(env, "OE8LOG-9", { ago: 60 });
        await flood(env, farCall, n);
        tiers.push((await scoreFind(env, trad, "OE8LOG-9", now())).result.tier);
      }
      expect(tiers).toEqual(["C", "C"]);
    });
  }

  it("does not hide an attested station fix that refuses the owner's signed ones", async () => {
    const tiers = [];
    for (const n of [0, FLOOD]) {
      const env = world();
      await account(env, "acct-own", "OE8OWN");
      const living = await cache(env, { type: "aprs_living", stationCall: "OE8OWN-9" });
      await attested(env, "OE8OWN-9", { ago: 250, dLat: 1 });
      await attested(env, "OE8LOG-9", { ago: 60 });
      await flood(env, "OE8OWN-9", n);
      tiers.push((await scoreFind(env, living, "OE8LOG-9", now())).result.tier);
    }
    expect(tiers).toEqual(["C", "C"]);
  });
});
