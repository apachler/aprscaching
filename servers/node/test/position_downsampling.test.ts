// SPDX-License-Identifier: AGPL-3.0-or-later
// The ingest stores a station's fixes on change: a fix is persisted when the station has moved
// POS_MIN_MOVE_M since its last stored fix or POS_MIN_INTERVAL_S has passed. Every fix of a protected
// station is stored — the stations verification reads — and every fix still reaches the live map,
// watch alerts and rendezvous. The trust guard below runs the same traffic with downsampling on and
// off and requires identical verification results.
import { describe, it, expect, afterEach, vi } from "vitest";
import { handleIngest } from "@aprscaching/gateway/ingest";
import { scoreFind } from "@aprscaching/gateway/caches";
import { queryPeerCorroboration } from "@aprscaching/gateway/corroborate";
import type { Env } from "@aprscaching/gateway/env";
import { freshDb, instanceEnv, newFedKey, serve, stubFetch } from "./helpers/fedpeer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITE = "OE8XXX";
const NOW = Math.floor(Date.now() / 1000);
const T0 = NOW - 1500; // every fix lands inside the 30 min verification window before NOW

/** `47°04.41'N` as the APRS uncompressed latitude `4704.41N` (and the longitude likewise). */
const aprsLat = (deg: number, min: number) => `${String(deg).padStart(2, "0")}${min.toFixed(2).padStart(5, "0")}N`;
const aprsLon = (deg: number, min: number) => `${String(deg).padStart(3, "0")}${min.toFixed(2).padStart(5, "0")}E`;
/** A position payload `latMin` minutes north of 47°N at 15°26.27'E. One hundredth of a minute is ~18.5 m. */
const pos = (latMin = 4.41, lonMin = 26.27) => `!${aprsLat(47, latMin)}/${aprsLon(15, lonMin)}>`;
const CACHE_LAT = 47 + 4.41 / 60;
const CACHE_LON = 15 + 26.27 / 60;

interface Fix {
  src: string;
  ts: number;
  payload?: string;
  heardVia?: "rf" | "aprs_is";
  port?: string;
  igateCall?: string;
  path?: string[];
}

interface Instance {
  env: Env;
  sqlite: ReturnType<typeof freshDb>["sqlite"];
  /** station deltas the live fan-out dispatched, in order */
  live: { callsign: string; lat: number; lon: number }[];
}

function instance(
  extra: Record<string, unknown> = {},
  name = "gw.test",
  key: Parameters<typeof instanceEnv>[1] = null,
) {
  const { sqlite, DB } = freshDb();
  const live: Instance["live"] = [];
  const room = {
    fetch: async (req: Request) => {
      const body = (await req.json()) as { envelopes: { station: { callsign: string; lat: number; lon: number } }[] };
      for (const e of body.envelopes) live.push(e.station);
      return new Response(null, { status: 204 });
    },
  };
  const env = instanceEnv(name, key, { FIRST_PARTY_SITES: SITE, ROOMS: { get: () => room }, ...extra }, DB);
  return { env, sqlite, live } as Instance;
}

async function ingest(env: Env, fixes: Fix[]) {
  const res = await handleIngest(
    new Request("http://gw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "test-ingest-secret" },
      body: JSON.stringify({
        packets: fixes.map((f) => ({
          src: f.src,
          dst: "APRS",
          path: f.path ?? ["WIDE1-1", "qAR", "OE3XIG"],
          payload: f.payload ?? pos(),
          heardVia: f.heardVia ?? "aprs_is",
          igateCall: f.igateCall ?? "OE3XIG",
          port: f.port ?? "aprs-is",
          ts: f.ts,
        })),
      }),
    }),
    env,
    { waitUntil: () => {} } as never,
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ ok: boolean; stored: number }>;
}

/** An RF hearing by the attested site's own TNC. */
const rf = (src: string, ts: number, payload = pos()): Fix => ({
  src,
  ts,
  payload,
  heardVia: "rf",
  port: "kiss-tnc",
  igateCall: SITE,
  path: ["WIDE1-1"],
});

/** `n` fixes of `src` at one place, `every` seconds apart from `from`, one packet per batch. */
async function stationary(
  env: Env,
  src: string,
  n: number,
  every: number,
  from = T0,
  make = (s: string, ts: number): Fix => ({ src: s, ts }),
) {
  for (let i = 0; i < n; i++) await ingest(env, [make(src, from + i * every)]);
}

const storedTs = (inst: Instance, callsign: string) =>
  (
    inst.sqlite.prepare("SELECT ts FROM positions WHERE callsign = ? ORDER BY ts").all(callsign) as { ts: number }[]
  ).map((r) => r.ts);

const lastSeen = (inst: Instance, callsign: string) =>
  (
    inst.sqlite.prepare("SELECT last_seen FROM stations WHERE callsign = ?").get(callsign) as
      { last_seen: number } | undefined
  )?.last_seen;

describe("position-on-change downsampling", () => {
  it("a stationary station that nothing protects stores one fix per interval", async () => {
    const gw = instance();
    await stationary(gw.env, "OE3STA", 11, 120); // 20 min of beacons every 2 min
    expect(storedTs(gw, "OE3STA")).toEqual([T0, T0 + 600, T0 + 1200]);
    expect(lastSeen(gw, "OE3STA")).toBe(T0 + 1200);
  });

  it("a moving station that nothing protects stores a fix once it has moved 25 m", async () => {
    const gw = instance();
    // steps of 0.01' (~18.5 m): the stored fixes are the ones 2 steps (~37 m) from the last stored one
    const mins = [4.41, 4.42, 4.43, 4.44, 4.45, 4.46];
    for (const [i, m] of mins.entries()) await ingest(gw.env, [{ src: "OE3MOV", ts: T0 + i * 10, payload: pos(m) }]);
    expect(storedTs(gw, "OE3MOV")).toEqual([T0, T0 + 20, T0 + 40]);
  });

  it("decides against the fix stored earlier in the same batch", async () => {
    const gw = instance();
    await ingest(gw.env, [
      { src: "OE3BAT", ts: T0 },
      { src: "OE3BAT", ts: T0 + 30 },
      { src: "OE3BAT", ts: T0 + 60, payload: pos(4.43) },
      { src: "OE3BAT", ts: T0 + 90, payload: pos(4.43) },
    ]);
    expect(storedTs(gw, "OE3BAT")).toEqual([T0, T0 + 60]);
    const st = gw.sqlite.prepare("SELECT lat, last_seen FROM stations WHERE callsign = 'OE3BAT'").get() as {
      lat: number;
      last_seen: number;
    };
    expect(st.last_seen).toBe(T0 + 60);
    expect(st.lat).toBeCloseTo(47 + 4.43 / 60, 6);
  });

  it("the thresholds are settings, and 0 in either turns downsampling off", async () => {
    for (const extra of [
      { POS_MIN_MOVE_M: "0", POS_MIN_INTERVAL_S: "0" },
      { POS_MIN_MOVE_M: "0" },
      { POS_MIN_INTERVAL_S: "0" },
    ]) {
      const gw = instance(extra);
      await stationary(gw.env, "OE3OFF", 5, 60);
      expect(storedTs(gw, "OE3OFF"), JSON.stringify(extra)).toHaveLength(5);
    }
    const wide = instance({ POS_MIN_INTERVAL_S: "120", POS_MIN_MOVE_M: "1000" });
    await stationary(wide.env, "OE3SET", 5, 60);
    expect(storedTs(wide, "OE3SET")).toEqual([T0, T0 + 120, T0 + 240]);
    const far = instance({ POS_MIN_MOVE_M: "1000" });
    for (const [i, m] of [4.41, 4.46, 4.51].entries())
      await ingest(far.env, [{ src: "OE3FAR", ts: T0 + i * 10, payload: pos(m) }]);
    expect(storedTs(far, "OE3FAR")).toEqual([T0]); // ~93 m hops stay under a 1 km threshold
  });

  it("stores every fix when the protection lookup fails", async () => {
    const gw = instance();
    const db = gw.env.DB;
    const failing = {
      ...db,
      batch: db.batch.bind(db),
      prepare: (sql: string) => {
        if (sql.includes("json_each")) throw new Error("lookup unavailable");
        return db.prepare(sql);
      },
    };
    const env = { ...gw.env, DB: failing } as Env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await stationary(env, "OE3ERR", 3, 60);
    expect(storedTs(gw, "OE3ERR")).toEqual([T0, T0 + 60, T0 + 120]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("a downsampled fix still reaches the live map and watch alerts", async () => {
    const gw = instance();
    await gw.env.DB.prepare(
      "INSERT INTO watch_calls (account_id, callsign, added_at) VALUES ('watcher', 'OE3WAT', 1)",
    ).run();
    await ingest(gw.env, [{ src: "OE3WAT", ts: T0 }]);
    gw.sqlite.prepare("DELETE FROM watch_alerts").run();
    const r = await ingest(gw.env, [{ src: "OE3WAT", ts: T0 + 60 }]);
    expect(storedTs(gw, "OE3WAT")).toEqual([T0]); // the second fix is not stored …
    expect(r.stored).toBe(1); // … but accepted
    expect(gw.live.filter((s) => s.callsign === "OE3WAT")).toHaveLength(2); // … and fanned out live
    const alerts = gw.sqlite.prepare("SELECT callsign FROM watch_alerts WHERE account_id = 'watcher'").all();
    expect(alerts).toEqual([{ callsign: "OE3WAT" }]);
  });
});

describe("readers of stations.last_seen allow for the interval", () => {
  it("the station list's recency window reaches back one interval further", async () => {
    const listed = async (extra: Record<string, unknown>) => {
      const gw = instance(extra);
      await gw.env.DB.prepare("INSERT INTO stations (callsign, lat, lon, last_seen) VALUES ('OE3LAG', 47, 15, ?)")
        .bind(Math.floor(Date.now() / 1000) - 400)
        .run();
      const res = await serve(gw.env)(new Request("https://gw.test/api/stations?maxAge=300"));
      return ((await res.json()) as { stations: { callsign: string }[] }).stations.map((s) => s.callsign);
    };
    expect(await listed({})).toEqual(["OE3LAG"]); // heard 400 s ago, beaconing still: its last_seen may trail
    expect(await listed({ POS_MIN_INTERVAL_S: "0" })).toEqual([]); // every fix stored: last_seen is exact
  });
});

describe("every fix of a protected station is stored", () => {
  const five = async (gw: Instance, src: string, make?: (s: string, ts: number) => Fix) => {
    await stationary(gw.env, src, 5, 60, T0, make);
    return storedTs(gw, src);
  };
  const all5 = [T0, T0 + 60, T0 + 120, T0 + 180, T0 + 240];

  it("an account holds the base call (any SSID)", async () => {
    const gw = instance();
    await gw.env.DB.prepare(
      "INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('a1', 'OE8HLD', 1, 1)",
    ).run();
    expect(await five(gw, "OE8HLD-9")).toEqual(all5);
    expect(await five(gw, "OE8HLD")).toEqual(all5);
  });

  it("the base call is control-verified", async () => {
    const gw = instance();
    await gw.env.DB.prepare(
      "INSERT INTO callsign_verifications (callsign, status, account_id, created_at) VALUES ('OE8VER', 'verified', 'a2', 1)",
    ).run();
    expect(await five(gw, "OE8VER-7")).toEqual(all5);
  });

  it("the callsign is a registered station", async () => {
    const gw = instance();
    await gw.env.DB.prepare(
      "INSERT INTO account_stations (account_id, callsign, lat, lon, created_at, updated_at) VALUES ('a3', 'OE8REG-10', 47, 15, 1, 1)",
    ).run();
    expect(await five(gw, "OE8REG-10")).toEqual(all5);
    expect(await five(gw, "OE8REG-9")).toEqual(all5); // another SSID of the same base call
  });

  it("the callsign has a find open: a radio command pending or sent in the window", async () => {
    const gw = instance();
    const cmd = (from: string, status: string, sentAt: number) =>
      gw.env.DB.prepare(
        `INSERT INTO radio_commands (from_call, command, raw_text, status, sent_at, created_at)
         VALUES (?, 'found', 'FOUND AC-1', ?, ?, ?)`,
      )
        .bind(from, status, sentAt, sentAt)
        .run();
    await cmd("OE8PND-7", "pending", NOW - 3 * 86400); // pending for days: still open
    await cmd("OE8RCT", "rejected", NOW - 600); // decided, but sent inside the window
    await cmd("OE8OLD", "logged", NOW - 7200); // decided long ago: no longer open
    expect(await five(gw, "OE8PND-7")).toEqual(all5);
    expect(await five(gw, "OE8RCT-5")).toEqual(all5);
    expect(await five(gw, "OE8OLD")).toEqual([T0]);
  });

  it("the callsign has a find open: a log in the verification window", async () => {
    const gw = instance();
    const log = (logger: string, ts: number) =>
      gw.env.DB.prepare("INSERT INTO cache_logs (cache_id, logger_call, ts, log_type) VALUES (1, ?, ?, 'found')")
        .bind(logger, ts)
        .run();
    await log("OE8LOG-7", NOW - 600);
    await log("OE8STL", NOW - 7200);
    expect(await five(gw, "OE8LOG")).toEqual(all5);
    expect(await five(gw, "OE8STL")).toEqual([T0]);
  });

  it("the callsign is the station of a living cache", async () => {
    const gw = instance();
    await gw.env.DB.prepare(
      `INSERT INTO caches (code, owner_call, title, type, station_call, created_at, updated_at)
       VALUES ('AC-LIV', 'OE8APR', 'Living', 'aprs_living', 'oe8liv-9', 1, 1)`,
    ).run();
    expect(await five(gw, "OE8LIV-9")).toEqual(all5);
  });

  it("the fix was heard directly on RF, whatever the callsign", async () => {
    const gw = instance();
    expect(await five(gw, "OE3RFA", (s, ts) => rf(s, ts))).toEqual(all5); // attested site's own TNC
    expect(await five(gw, "OE3RFB", (s, ts) => ({ src: s, ts, heardVia: "rf" }))).toEqual(all5);
    expect(await five(gw, "OE3RFC", (s, ts) => ({ src: s, ts, port: "meshcom", heardVia: "aprs_is" }))).toEqual(all5);
    // the APRS-IS copies of an RF-heard station are still downsampled
    expect(await five(gw, "OE3RFD")).toEqual([T0]);
  });
});

describe("the trust guard: verification is identical with downsampling on and off", () => {
  /** The same traffic and accounts on one instance. */
  async function world(inst: Instance) {
    const db = inst.env.DB;
    for (const [acct, call] of [
      ["acct-rf", "OE8RFL"],
      ["acct-app", "OE8APP"],
      ["acct-is", "OE8ISL"],
      ["acct-liv", "OE8LVL"],
    ] as const)
      await db
        .prepare("INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES (?, ?, 1, 1)")
        .bind(acct, call)
        .run();
    const trad = await db
      .prepare(
        `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at)
         VALUES ('AC-TRD', 'OE8APR', 'Traditional', 'traditional', ?, ?, 1, 1)`,
      )
      .bind(CACHE_LAT, CACHE_LON)
      .run();
    const living = await db
      .prepare(
        `INSERT INTO caches (code, owner_call, title, type, station_call, created_at, updated_at)
         VALUES ('AC-LVG', 'OE8APR', 'Living', 'aprs_living', 'OE5LIV-9', 1, 1)`,
      )
      .run();
    // 25 min of traffic, one batch every 60 s: the loggers, the living cache's station, a peer's
    // logger heard on RF here, and background stations nothing protects
    for (let i = 0; i < 25; i++) {
      const ts = T0 + i * 60;
      const far = pos(9.41); // ~9 km north
      const living = pos(20.41 + Math.floor(i / 10) * 0.01); // the living cache creeps ~18.5 m every 10 min
      await ingest(inst.env, [
        // Tier A: RF hearings at the cache by the attested site, plus their APRS-IS copies elsewhere
        ...(i % 5 === 0 ? [rf("OE8RFL-9", ts)] : []),
        { src: "OE8RFL-9", ts: ts + 1, payload: i % 5 === 0 ? pos() : far },
        // Tier B / C: stationary APRS-IS beacons at the cache
        { src: "OE8APP-7", ts },
        { src: "OE8ISL", ts },
        // living cache: the logger on RF beside its moving station, the station on APRS-IS and, now and then,
        // heard by the attested site too (only that hearing places the cache for Tier A)
        { src: "OE5LIV-9", ts, payload: living },
        ...(i % 6 === 0 ? [rf("OE8LVL", ts, living), rf("OE5LIV-9", ts, living)] : []),
        // a logger with no account here, heard on RF, whom a peer may ask about
        rf("DL1PEER", ts),
        { src: "DL1PEER", ts: ts + 2 },
        // background traffic
        { src: "OE3BG1", ts },
        { src: "OE3BG2", ts, payload: pos(30.41 + (i % 2) * 0.01) },
      ]);
    }
    return { trad: Number(trad.meta.last_row_id), living: Number(living.meta.last_row_id) };
  }

  /** scoreFind's result with the matched position named by its content, not its row id. */
  async function score(
    inst: Instance,
    cacheId: number,
    logger: string,
    appGeo?: { lat: number; lon: number; accuracyM: number; ts: number },
  ) {
    const cache = (await inst.env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(cacheId).first()) as never;
    const s = await scoreFind(inst.env, cache, logger, NOW, appGeo);
    const { matchedPositionId, ...result } = s.result;
    const matched =
      matchedPositionId == null
        ? null
        : inst.sqlite
            .prepare("SELECT callsign, ts, lat, lon, heard_via, igate_call, transport FROM positions WHERE id = ?")
            .get(matchedPositionId);
    return { ...s, result, matched };
  }

  it("Tier A, B and C finds, a living cache and a peer's RF corroboration answer come out the same", async () => {
    const on = instance();
    const off = instance({ POS_MIN_MOVE_M: "0", POS_MIN_INTERVAL_S: "0" });
    const ids = await world(on);
    expect(await world(off)).toEqual(ids);

    // the background is thinned, so the two instances really differ
    expect(storedTs(on, "OE3BG1").length).toBeLessThan(storedTs(off, "OE3BG1").length);

    const appGeo = { lat: CACHE_LAT, lon: CACHE_LON, accuracyM: 10, ts: NOW };
    const cases = [
      { cache: ids.trad, logger: "OE8RFL-9", tier: "A" },
      { cache: ids.trad, logger: "OE8APP-7", appGeo, tier: "B" },
      { cache: ids.trad, logger: "OE8ISL", tier: "C" },
      { cache: ids.living, logger: "OE8LVL", tier: "A" },
      { cache: ids.trad, logger: "DL1PEER", tier: "A" },
    ];
    for (const c of cases) {
      const a = await score(on, c.cache, c.logger, c.appGeo);
      const b = await score(off, c.cache, c.logger, c.appGeo);
      expect(a, c.logger).toEqual(b);
      expect(a.result.tier, c.logger).toBe(c.tier);
    }

    // every fix verification reads for the protected stations is stored on both instances
    for (const call of ["OE8RFL-9", "OE8APP-7", "OE8ISL", "OE8LVL", "OE5LIV-9"])
      expect(storedTs(on, call), call).toEqual(storedTs(off, call));
    // and every RF hearing of the account-less logger, which the corroboration answerer reads
    const rfRows = (inst: Instance) =>
      inst.sqlite
        .prepare(
          "SELECT ts, lat, lon, igate_call FROM positions WHERE callsign = 'DL1PEER' AND heard_via = 'rf' ORDER BY ts",
        )
        .all();
    expect(rfRows(on)).toEqual(rfRows(off));
    expect(rfRows(on)).toHaveLength(25);

    // a peer asks each instance whether it heard DL1PEER on RF at the cache: the signed answers agree
    const answers = [];
    const key = await newFedKey(); // one peer identity, so the answers can be compared whole
    for (const inst of [on, off]) {
      const answerer = instance({ FED_CORROBORATION_QUORUM: "1" }, "p1.example", key);
      // the answerer runs on the instance's database
      const ans = { ...answerer.env, DB: inst.env.DB } as Env;
      const hub = instance({ FED_CORROBORATION_QUORUM: "1" }, "hub.example", await newFedKey());
      await hub.env.DB.prepare(
        "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, ?, ?, ?, 'trusted', 'manual')",
      )
        .bind("https://p1.example", "p1.example", key.pub, JSON.stringify([{ x: key.pub }]))
        .run();
      stubFetch({ "https://p1.example": serve(ans) });
      answers.push(
        await queryPeerCorroboration(hub.env, {
          callsign: "DL1PEER",
          lat: CACHE_LAT,
          lon: CACHE_LON,
          radiusM: 150,
          since: NOW - 1800,
          until: NOW,
        }),
      );
      vi.unstubAllGlobals();
    }
    expect(answers[0]).not.toBeNull();
    expect(answers[0]).toEqual(answers[1]);
  });
});
