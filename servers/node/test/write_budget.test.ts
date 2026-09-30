// SPDX-License-Identifier: AGPL-3.0-or-later
// The daily write budget sheds low-value writes first. From 80 % of the budget the raw packet ring pauses
// and a station nothing protects stores a fix six times less often; from 100 % only what verification,
// finds and accounts need is stored, and everything else reaches the live map without being persisted.
// Protected stations' fixes, RF hearings and finds are stored at every level. The counter lives in the
// in-process rooms here, as it does in the Durable Object on Cloudflare.
import { describe, it, expect, afterEach, vi } from "vitest";
import { handleIngest } from "@aprscaching/gateway/ingest";
import { scoreFind } from "@aprscaching/gateway/caches";
import { runScheduled } from "@aprscaching/gateway/app";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import type { Env } from "@aprscaching/gateway/env";
import { roomNamespace } from "../src/host.js";
import { freshDb, instanceEnv, stubFetch } from "./helpers/fedpeer.js";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITE = "OE8XXX";
const NOW = Math.floor(Date.now() / 1000);
const T0 = NOW - 2 * 3600;
const POS = "!4704.41N/01526.27E>";
const CACHE_LAT = 47 + 4.41 / 60;
const CACHE_LON = 15 + 26.27 / 60;

interface Gw {
  env: Env;
  sqlite: ReturnType<typeof freshDb>["sqlite"];
  rooms: RoomsCore;
  /** callsigns the live fan-out carried, in order */
  live: string[];
}

/** The live rooms of a self-host server, with the station deltas they dispatch recorded. */
function liveRooms(rooms: RoomsCore, live: string[]) {
  const ns = roomNamespace(rooms);
  return {
    idFromName: ns.idFromName,
    get: (id: unknown) => ({
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname === "/dispatch") {
          const body = (await req.clone().json()) as { envelopes: { station: { callsign: string } }[] };
          for (const e of body.envelopes) live.push(e.station.callsign);
        }
        return ns.get(id).fetch(req);
      },
    }),
  };
}

function gateway(extra: Record<string, unknown> = {}, base: (x: Record<string, unknown>) => Env = plainEnv): Gw {
  const rooms = new RoomsCore({ heartbeatMs: 0 });
  const live: string[] = [];
  const env = base({ FIRST_PARTY_SITES: SITE, ROOMS: liveRooms(rooms, live), ...extra });
  const sqlite = (env as unknown as { __sqlite: Gw["sqlite"] }).__sqlite;
  return { env, sqlite, rooms, live };
}

function plainEnv(extra: Record<string, unknown>): Env {
  const { sqlite, DB } = freshDb();
  const env = instanceEnv("gw.test", null, extra, DB);
  Object.defineProperty(env, "__sqlite", { value: sqlite });
  return env;
}

function signInEnv(extra: Record<string, unknown>): Env {
  const { sqlite, DB } = freshDb();
  const env = authEnv(extra, DB);
  Object.defineProperty(env, "__sqlite", { value: sqlite });
  return env;
}

/** Bring today's count to `used` rows before the test's own traffic. */
async function spend(gw: Gw, used: number) {
  const r = await gw.rooms.budgetCounter.add(used, Number(gw.env.D1_DAILY_WRITE_BUDGET ?? 0));
  return r.level;
}

interface Pkt {
  src: string;
  ts: number;
  payload?: string;
  rf?: boolean;
}

async function ingest(env: Env, packets: Pkt[]) {
  const res = await handleIngest(
    new Request("http://gw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "test-ingest-secret" },
      body: JSON.stringify({
        packets: packets.map((p) => ({
          src: p.src,
          dst: "APRS",
          path: p.rf ? ["WIDE1-1"] : ["WIDE1-1", "qAR", "OE3XIG"],
          payload: p.payload ?? POS,
          heardVia: p.rf ? "rf" : "aprs_is",
          igateCall: p.rf ? SITE : "OE3XIG",
          port: p.rf ? "kiss-tnc" : "aprs-is",
          ts: p.ts,
        })),
      }),
    }),
    env,
    { waitUntil: () => {} } as never,
  );
  expect(res.status).toBe(200);
}

const count = (gw: Gw, sql: string, ...args: unknown[]) =>
  (gw.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args) as { n: number }).n;
const storedTs = (gw: Gw, call: string) =>
  (gw.sqlite.prepare("SELECT ts FROM positions WHERE callsign = ? ORDER BY ts").all(call) as { ts: number }[]).map(
    (r) => r.ts,
  );

/** OE8HLD is held by an account; OE8APR holds a verified account and a cache waits at AC-0001. */
function seed(gw: Gw) {
  gw.sqlite.exec(`
    INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('a-hld', 'OE8HLD', 1, 1);
    INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('a-apr', 'OE8APR', 1, 1);
    INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8APR', 'operator', 'verified', 1);
  `);
  gw.sqlite
    .prepare(
      "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES ('AC-0001','OE3OWN','Test cache','traditional',?,?,1,1)",
    )
    .run(CACHE_LAT, CACHE_LON);
}

const FOUND = ":APRSCG   :FOUND AC-0001 nice spot{12";

describe("at 80 % of the budget", () => {
  it("pauses the raw packet ring and stores a fix of an unprotected station six times less often", async () => {
    const gw = gateway({ D1_DAILY_WRITE_BUDGET: "1000000" });
    seed(gw);
    expect(await spend(gw, 850_000)).toBe("warn");
    // an hour of beacons every 10 minutes from a station nothing protects, and from a held call
    for (let i = 0; i <= 6; i++)
      await ingest(gw.env, [
        { src: "OE3STA", ts: T0 + i * 600 },
        { src: "OE8HLD-9", ts: T0 + i * 600 },
      ]);
    expect(count(gw, "packets_recent")).toBe(0);
    expect(storedTs(gw, "OE3STA")).toEqual([T0, T0 + 3600]);
    expect(storedTs(gw, "OE8HLD-9")).toHaveLength(7);
    // every beacon still reached the live map
    expect(gw.live.filter((c) => c === "OE3STA")).toHaveLength(7);
  });

  it("stores every fix of an unprotected station per interval below it", async () => {
    const gw = gateway({ D1_DAILY_WRITE_BUDGET: "1000000" });
    for (let i = 0; i <= 6; i++) await ingest(gw.env, [{ src: "OE3STA", ts: T0 + i * 600 }]);
    expect(storedTs(gw, "OE3STA")).toHaveLength(7);
    expect(count(gw, "packets_recent")).toBe(7);
  });
});

describe("at 100 % of the budget", () => {
  it("stores protected fixes, RF hearings and finds, and sends everything else to the live map only", async () => {
    const gw = gateway({ D1_DAILY_WRITE_BUDGET: "1000000" });
    seed(gw);
    expect(await spend(gw, 1_000_000)).toBe("over");
    await ingest(gw.env, [
      { src: "OE8HLD-9", ts: T0 }, // an account's station, over APRS-IS
      { src: "OE3RFX", ts: T0, rf: true }, // nothing protects it, but the site's own TNC heard it
      { src: "OE8APR-7", ts: T0, payload: FOUND, rf: true }, // a find logged by radio
      { src: "OE3NOP", ts: T0 }, // nothing protects it, heard over APRS-IS
      { src: "OE3NOP", ts: T0 + 1, payload: ":OE3OTH   :hi there{1" }, // a message between unprotected calls
      { src: "OE3NOP", ts: T0 + 2, payload: ":OE8HLD   :hello{2" }, // a message to a held call
      { src: "OE3WX", ts: T0, payload: "_10090556c220s004g005t077r000p000P000h50b09900wRSW" },
    ]);
    expect(storedTs(gw, "OE8HLD-9")).toEqual([T0]);
    expect(storedTs(gw, "OE3RFX")).toEqual([T0]);
    expect(storedTs(gw, "OE3NOP")).toEqual([]);
    expect(count(gw, "stations WHERE callsign = 'OE3NOP'")).toBe(0);
    expect(gw.live).toEqual(expect.arrayContaining(["OE8HLD-9", "OE3RFX", "OE3NOP"]));
    // the find is processed and logged
    expect(count(gw, "radio_commands WHERE from_call = 'OE8APR-7'")).toBe(1);
    expect(count(gw, "cache_logs WHERE logger_call = 'OE8APR-7' AND log_type = 'found'")).toBe(1);
    // messages: the radio command and the one to a held call are kept
    expect(
      (gw.sqlite.prepare("SELECT to_call FROM messages ORDER BY to_call").all() as { to_call: string }[]).map(
        (r) => r.to_call,
      ),
    ).toEqual(["APRSCG", "OE8HLD"]);
    // the diagnostic tables are paused; MHeard keeps what the site's own receiver heard
    expect(count(gw, "packets_recent")).toBe(0);
    expect(count(gw, "sensor_readings")).toBe(0);
    expect(count(gw, "port_stats")).toBe(0);
    expect(
      (gw.sqlite.prepare("SELECT callsign FROM node_mheard ORDER BY callsign").all() as { callsign: string }[]).map(
        (r) => r.callsign,
      ),
    ).toEqual(["OE3RFX", "OE8APR-7"]);
  });
});

describe("protected data at every level", () => {
  for (const [level, used] of [
    ["ok", 0],
    ["warn", 850_000],
    ["over", 1_200_000],
  ] as const) {
    it(`stores every fix of a protected station and every find (${level})`, async () => {
      const gw = gateway({ D1_DAILY_WRITE_BUDGET: "1000000" });
      seed(gw);
      expect(await spend(gw, used)).toBe(level);
      for (let i = 0; i < 5; i++) await ingest(gw.env, [{ src: "OE8HLD-9", ts: T0 + i * 60 }]);
      await ingest(gw.env, [{ src: "OE8APR-7", ts: T0 + 400, payload: FOUND, rf: true }]);
      expect(storedTs(gw, "OE8HLD-9")).toHaveLength(5);
      expect(count(gw, "cache_logs WHERE logger_call = 'OE8APR-7'")).toBe(1);
    });
  }
});

describe("the trust guard: verification is identical over budget and without a budget", () => {
  /** A living cache's station, and three loggers beaconing at a traditional cache: on RF, and over APRS-IS. */
  async function world(gw: Gw) {
    gw.sqlite.exec(`
      INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES
        ('acct-rf', 'OE8RFL', 1, 1), ('acct-app', 'OE8APP', 1, 1), ('acct-is', 'OE8ISL', 1, 1), ('acct-liv', 'OE8LVL', 1, 1);
    `);
    gw.sqlite
      .prepare(
        `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at)
         VALUES ('AC-TRD', 'OE8APR', 'Traditional', 'traditional', ?, ?, 1, 1)`,
      )
      .run(CACHE_LAT, CACHE_LON);
    gw.sqlite.exec(`INSERT INTO caches (code, owner_call, title, type, station_call, created_at, updated_at)
       VALUES ('AC-LVG', 'OE8APR', 'Living', 'aprs_living', 'OE5LIV-9', 1, 1)`);
    const living = "!4724.41N/01526.27E>";
    for (let i = 0; i < 25; i++) {
      const ts = NOW - 1500 + i * 60;
      await ingest(gw.env, [
        ...(i % 5 === 0 ? [{ src: "OE8RFL-9", ts, rf: true }] : []),
        { src: "OE8APP-7", ts },
        { src: "OE8ISL", ts },
        { src: "OE5LIV-9", ts, payload: living },
        ...(i % 6 === 0 ? [{ src: "OE8LVL", ts, payload: living, rf: true }] : []),
        { src: "OE3BG1", ts },
      ]);
    }
  }

  async function score(gw: Gw, code: string, logger: string, appGeo?: Parameters<typeof scoreFind>[4]) {
    const cache = gw.sqlite.prepare("SELECT * FROM caches WHERE code = ?").get(code) as never;
    const s = await scoreFind(gw.env, cache, logger, NOW, appGeo);
    const { matchedPositionId, ...result } = s.result;
    const matched =
      matchedPositionId == null
        ? null
        : gw.sqlite
            .prepare("SELECT callsign, ts, lat, lon, heard_via FROM positions WHERE id = ?")
            .get(matchedPositionId);
    return { ...s, result, matched };
  }

  it("Tier A, B and C finds and a living cache come out the same", async () => {
    const over = gateway({ D1_DAILY_WRITE_BUDGET: "1000000" });
    await spend(over, 2_000_000);
    const free = gateway();
    await world(over);
    await world(free);
    // the background is shed, so the two instances really differ
    expect(storedTs(over, "OE3BG1")).toEqual([]);
    expect(storedTs(free, "OE3BG1").length).toBeGreaterThan(0);

    const appGeo = { lat: CACHE_LAT, lon: CACHE_LON, accuracyM: 10, ts: NOW };
    for (const c of [
      { code: "AC-TRD", logger: "OE8RFL-9", tier: "A" },
      { code: "AC-TRD", logger: "OE8APP-7", appGeo, tier: "B" },
      { code: "AC-TRD", logger: "OE8ISL", tier: "C" },
      { code: "AC-LVG", logger: "OE8LVL", tier: "A" },
    ]) {
      const a = await score(over, c.code, c.logger, c.appGeo);
      const b = await score(free, c.code, c.logger, c.appGeo);
      expect(a, c.logger).toEqual(b);
      expect(a.result.tier, c.logger).toBe(c.tier);
    }
    for (const call of ["OE8RFL-9", "OE8APP-7", "OE8ISL", "OE8LVL", "OE5LIV-9"])
      expect(storedTs(over, call), call).toEqual(storedTs(free, call));
  });
});

describe("on Node and Bun the guard is off unless set", () => {
  it("throttles nothing without the setting, whatever the count", async () => {
    const gw = gateway();
    await gw.rooms.budgetCounter.add(1e12, 1);
    for (let i = 0; i <= 2; i++) await ingest(gw.env, [{ src: "OE3STA", ts: T0 + i * 600 }]);
    expect(storedTs(gw, "OE3STA")).toHaveLength(3);
    expect(count(gw, "packets_recent")).toBe(3);
    expect(count(gw, "port_stats")).toBeGreaterThan(0); // one hourly bucket, or two across an hour boundary
  });

  it("counts the rows the ingest writes once it is set", async () => {
    const gw = gateway({ D1_DAILY_WRITE_BUDGET: "1000000" });
    await ingest(gw.env, [{ src: "OE3STA", ts: T0 }]);
    const v = await gw.rooms.budgetCounter.view(1_000_000);
    // SQLite reports changed rows, not index rows: at least the packet ring, the fix, the station and MHeard
    expect(v.used).toBeGreaterThanOrEqual(4);
  });
});

describe("the sysop is told once per threshold per day", () => {
  it("shows the alerts on the admin status and mails them in the next digest, once", async () => {
    const gw = gateway({ D1_DAILY_WRITE_BUDGET: "1000", ADMIN_CALLSIGNS: "OE8APR" }, signInEnv);
    const op = await emailSignup(gw.env, "op@example.test", "OE8APR");
    await operatorVerify(gw.env, "OE8APR");
    await spend(gw, 790);
    // the ingest's own writes cross 80 %, later ones 100 %
    for (let i = 0; i < 60; i++)
      await ingest(
        gw.env,
        [0, 1, 2, 3, 4].map((k) => ({ src: `OE3S${i}-${k}`, ts: T0 + i })),
      );

    const status = await call(gw.env, "GET", "/api/admin/setup", undefined, { cookie: op.cookie });
    expect(status.status).toBe(200);
    expect(status.data.budget).toMatchObject({ budget: 1000, level: "over" });
    expect(status.data.budget.used).toBeGreaterThanOrEqual(1000);
    expect(status.data.budget.alerts.map((a: { threshold: number }) => a.threshold)).toEqual([80, 100]);
    // the status is sysop-only
    const user = await emailSignup(gw.env, "user@example.test", "OE3USR");
    expect((await call(gw.env, "GET", "/api/admin/setup", undefined, { cookie: user.cookie })).status).toBe(403);

    const mails: { to: string; subject: string; text: string }[] = [];
    stubFetch({
      "https://api.resend.com": async (req) => {
        mails.push((await req.json()) as (typeof mails)[number]);
        return new Response("{}", { status: 200 });
      },
    });
    gw.env.EMAIL_API_KEY = "re_test";
    gw.env.EMAIL_FROM = "gw@example.test";
    await runScheduled(gw.env);
    await runScheduled(gw.env);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("op@example.test");
    expect(mails[0]!.text).toContain("80 %");
    expect(mails[0]!.text).toContain("100 %");
    // the banner still lists today's alerts after the mail
    const after = await call(gw.env, "GET", "/api/admin/setup", undefined, { cookie: op.cookie });
    expect(after.data.budget.alerts).toHaveLength(2);
  });
});
