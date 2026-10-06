// SPDX-License-Identifier: AGPL-3.0-or-later
// What counts as Tier A/B evidence, through the real gateway over a migrated SQLite: a living cache is where its
// station was heard by an attested site or by the owner's own signed browser bridge, and an APRS-IS-only fix of
// the station caps the find at Tier C; a fix that matches a beacon this instance asked a box to send is tagged
// and never lifts a find; a fix delivered by a box the logger's account owns is the logger's own hearing.
import { describe, it, expect } from "vitest";
import { scoreFind } from "@aprscaching/gateway/caches";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, markCallVerified } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const SITE = "OE8XXX-10";
// the spot every test position sits at: !4704.20N/01525.20E>
const LAT = 47 + 4.2 / 60;
const LON = 15 + 25.2 / 60;
const AT_SPOT = "!4704.20N/01525.20E>";
const now = () => Math.floor(Date.now() / 1000);

const room = { fetch: async () => new Response(null, { status: 204 }) };
const world = () => authEnv({ FIRST_PARTY_SITES: SITE, ROOMS: { get: () => room } });

/** The base call `call` held by account `id`. */
async function account(env: Env, id: string, call: string) {
  await env.DB.prepare("INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES (?,?,1,0)")
    .bind(id, call)
    .run();
}

async function cache(env: Env, o: { type: string; stationCall?: string; owner?: string }) {
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, station_call, created_at, updated_at)
     VALUES (?, ?, 'Test', ?, ?, ?, ?, 1, 1)`,
  )
    .bind(
      `AC-EV${Math.random().toString(36).slice(2, 8)}`,
      o.owner ?? "OE8OWN",
      o.type,
      LAT,
      LON,
      o.stationCall ?? null,
    )
    .run();
  return (await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(Number(r.meta.last_row_id)).first()) as never;
}

async function position(
  env: Env,
  p: { call: string; via?: string; igate?: string | null; transport: string; source: string; box?: string | null },
) {
  await env.DB.prepare(
    `INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport, ingest_box)
     VALUES (?,?,?,?,?,?, 'WIDE1-1', ?, ?, ?)`,
  )
    .bind(p.call, now() - 60, LAT, LON, p.via ?? "rf", p.igate ?? null, p.source, p.transport, p.box ?? null)
    .run();
}

/** The trusted ingest posts one frame its own TNC heard at the spot, named for the attested site. */
async function heard(env: Env, src: string, payload = AT_SPOT) {
  const res = await call(
    env,
    "POST",
    "/ingest",
    {
      packets: [
        {
          src,
          dst: "APRS",
          path: [],
          payload,
          kind: "position",
          heardVia: "rf",
          port: "kiss-tnc",
          ts: now() - 30,
          igateCall: SITE,
        },
      ],
    },
    INGEST,
  );
  expect(res.status, JSON.stringify(res.data)).toBe(200);
}

const phoneAtSpot = () => ({ lat: LAT, lon: LON, accuracyM: 10, ts: now() });

describe("a living cache is where an attested site or its owner's own bridge heard its station", () => {
  it("caps a find beside an APRS-IS-only station fix at Tier C, on the phone and on RF", async () => {
    const env = world();
    await account(env, "acct-own", "OE8OWN");
    const living = await cache(env, { type: "aprs_living", stationCall: "OE8OWN-9" });
    await position(env, {
      call: "OE8OWN-9",
      via: "aprs_is",
      igate: "OE8ZZZ",
      transport: "aprs-is",
      source: "firehose",
    });
    const phone = await scoreFind(env, living, "OE8LOG-9", now(), phoneAtSpot());
    expect(phone.result).toMatchObject({ tier: "C", verified: false });
    await position(env, { call: "OE8LOG-9", igate: SITE, transport: "tnc", source: "firehose" });
    const rf = await scoreFind(env, living, "OE8LOG-9", now());
    expect(rf.result).toMatchObject({ tier: "C", verified: false });
  });

  it("follows the station heard by an attested site to Tier A", async () => {
    const env = world();
    await account(env, "acct-own", "OE8OWN");
    const living = await cache(env, { type: "aprs_living", stationCall: "OE8OWN-9" });
    await position(env, { call: "OE8OWN-9", igate: SITE, transport: "tnc", source: "firehose" });
    await position(env, { call: "OE8LOG-9", igate: SITE, transport: "tnc", source: "firehose" });
    expect((await scoreFind(env, living, "OE8LOG-9", now())).result).toMatchObject({ tier: "A", verified: true });
  });

  it("follows the owner's own signed browser-RF fix to Tier B, but no other caller's", async () => {
    const env = world();
    await account(env, "acct-own", "OE8OWN");
    const mine = await cache(env, { type: "aprs_living", stationCall: "OE8OWN-9" });
    await position(env, { call: "OE8OWN-9", transport: "browser-rf", source: "browser-rf" });
    expect((await scoreFind(env, mine, "OE8LOG-9", now(), phoneAtSpot())).result).toMatchObject({
      tier: "B",
      verified: true,
    });
    // a station whose base call the owner's account does not hold
    const club = await cache(env, { type: "aprs_living", stationCall: "OE8CLB-9" });
    await position(env, { call: "OE8CLB-9", transport: "browser-rf", source: "browser-rf" });
    expect((await scoreFind(env, club, "OE8LOG-9", now(), phoneAtSpot())).result.tier).toBe("C");
  });
});

describe("a beacon this instance asked a box to send", () => {
  async function boxBeacon(env: Env, callsign: string) {
    await markCallVerified(env, callsign);
    const q = await call(env, "POST", "/api/box/pi-home/command", { kind: "beacon", callsign }, INGEST);
    expect(q.status, JSON.stringify(q.data)).toBe(201);
    const leased = await call(env, "GET", "/api/box/pi-home/commands?tx=1&rf=1", undefined, INGEST);
    expect(leased.data.commands).toHaveLength(1);
    return q.data.id as number;
  }

  it("is tagged when heard, and never lifts a find to Tier A", async () => {
    const env = world();
    const trad = await cache(env, { type: "traditional" });
    await boxBeacon(env, "OE8LOG-9");
    await heard(env, "OE8LOG-9");
    const row = await env.DB.prepare("SELECT commanded FROM positions WHERE callsign = 'OE8LOG-9'").first<{
      commanded: number;
    }>();
    expect(row?.commanded).toBe(1);
    expect((await scoreFind(env, trad, "OE8LOG-9", now())).result.tier).toBe("C");
  });

  it("leaves another call's hearings, and the same call far from the beacon the box reported, untagged", async () => {
    const env = world();
    const trad = await cache(env, { type: "traditional" });
    const id = await boxBeacon(env, "OE8BOX-10");
    const ack = await call(
      env,
      "POST",
      "/api/box/pi-home/commands/ack",
      { id, status: "done", result: "beacon sent", position: { lat: 48.2, lon: 16.37 } },
      INGEST,
    );
    expect(ack.status).toBe(200);
    await heard(env, "OE8LOG-9");
    await heard(env, "OE8BOX-10"); // the box's call, but at the spot, not where the box beaconed
    const rows = (
      await env.DB.prepare("SELECT callsign, commanded FROM positions ORDER BY callsign").all<{
        callsign: string;
        commanded: number;
      }>()
    ).results;
    expect(rows).toEqual([
      { callsign: "OE8BOX-10", commanded: 0 },
      { callsign: "OE8LOG-9", commanded: 0 },
    ]);
    expect((await scoreFind(env, trad, "OE8LOG-9", now())).result).toMatchObject({ tier: "A", verified: true });
  });

  it("names no position of its own: the box beacons where it is configured to be", async () => {
    const env = world();
    await markCallVerified(env, "OE8LOG-9");
    const q = await call(
      env,
      "POST",
      "/api/box/pi-home/command",
      { kind: "beacon", callsign: "OE8LOG-9", payload: { lat: LAT, lon: LON } },
      INGEST,
    );
    expect(q.status).toBe(400);
    expect(q.data.error).toMatch(/configured position/);
  });
});

describe("a box the logger's account owns", () => {
  async function lentBox(env: Env, owner: string | null) {
    await env.DB.prepare(
      "INSERT INTO box_keys (box_id, public_key, enrolled_by, enrolled_at) VALUES ('pi-home', 'k', 'operator', 0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO box_trusted_sites (box_id, site, trusted_by, trusted_at) VALUES ('pi-home', 'OE3LND-10', 'operator', 0)",
    ).run();
    if (owner)
      await env.DB.prepare("INSERT INTO boxes (box_id, account_id, created_at) VALUES ('pi-home', ?, 0)")
        .bind(owner)
        .run();
  }

  it("is the logger's own receiver: its hearings never lift the logger's find to Tier A", async () => {
    const env = world();
    await account(env, "acct-log", "OE8LOG");
    await lentBox(env, "acct-log");
    const trad = await cache(env, { type: "traditional" });
    await position(env, { call: "OE8LOG-9", igate: "OE3LND-10", transport: "tnc", source: "firehose", box: "pi-home" });
    expect((await scoreFind(env, trad, "OE8LOG-9", now())).result.tier).toBe("C");
  });

  it("another account's box still corroborates the logger", async () => {
    const env = world();
    await account(env, "acct-log", "OE8LOG");
    await account(env, "acct-lnd", "OE3LND");
    await lentBox(env, "acct-lnd");
    const trad = await cache(env, { type: "traditional" });
    await position(env, { call: "OE8LOG-9", igate: "OE3LND-10", transport: "tnc", source: "firehose", box: "pi-home" });
    expect((await scoreFind(env, trad, "OE8LOG-9", now())).result).toMatchObject({ tier: "A", verified: true });
  });
});
