// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D1 rows written per ingested packet, and per row the nightly prune removes.
 *
 * Cloudflare D1 bills rows written, and a Worker deployment pays for every one of them, so this suite pins
 * the write cost of the ingest path as exact expected values. A change that makes a packet cost more rows
 * fails here; a change that makes it cost fewer updates these values in the same commit.
 *
 * Method: the statements run against workerd's local D1 (wrangler's `getPlatformProxy`, the same
 * engine `wrangler dev` uses), and every result's `meta.rows_written` is summed per table. That counter is
 * the one D1 reports and bills, so it already includes what a statement-level count misses:
 *  - one row per secondary index an INSERT fills, including the implicit index behind a TEXT or composite
 *    PRIMARY KEY on a rowid table (stations, node_mheard, port_stats, sensor_readings);
 *  - one row for the `sqlite_sequence` bump on every INSERT into an AUTOINCREMENT table (packets_recent,
 *    positions, messages);
 *  - on an UPDATE or an upsert that updates, the row plus each index whose columns the SET list names,
 *    whether or not the value changed;
 *  - an UPDATE that matches nothing costs nothing, and so does an upsert whose DO UPDATE ... WHERE is false.
 * A DELETE reports one row per deleted row: the index entries it removes are not counted.
 *
 * Each packet kind is measured in steady state (the station, the port and the hourly counter bucket
 * already exist, which is the common case on a live feed); a first-heard station is measured separately.
 * The measured packet follows the warm-up one by a second, so a fix from a station nothing protects that
 * has not moved is not stored (downsample.ts); the cases say which fixes are stored and why.
 * The rows written by BBS delivery, watch alerts, rendezvous and radio commands depend on held mail,
 * watchers and opted-in caches; none exist here, so those paths read and write nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { handleIngest } from "../src/ingest.js";
import { runScheduled } from "../src/app.js";
import type { Env } from "../src/env.js";
import type { SqlDatabase, SqlResult, SqlStatement } from "../src/runtime.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

/** The table a write statement targets, or null for a read. */
function writeTarget(sql: string): string | null {
  const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(sql);
  return m ? m[1]! : null;
}

interface Tally {
  /** rows_written per table */
  written: Record<string, number>;
  /** rows changed per table (statement-level `changes`) */
  changed: Record<string, number>;
}

/** A D1 view that forwards to the real binding and tallies `meta.rows_written` per table. */
function counting(db: SqlDatabase): { db: SqlDatabase; take: () => Tally } {
  let tally: Tally = { written: {}, changed: {} };
  const note = (sql: string, r: SqlResult) => {
    const meta = r.meta as { rows_written?: number; changes?: number };
    const rw = meta.rows_written ?? 0;
    const table = writeTarget(sql);
    if (!table) {
      expect(rw, `a read wrote rows: ${sql}`).toBe(0);
      return;
    }
    tally.written[table] = (tally.written[table] ?? 0) + rw;
    tally.changed[table] = (tally.changed[table] ?? 0) + (meta.changes ?? 0);
  };
  class Stmt implements SqlStatement {
    constructor(
      readonly sql: string,
      readonly inner: SqlStatement,
    ) {}
    bind(...v: unknown[]): SqlStatement {
      return new Stmt(this.sql, this.inner.bind(...v));
    }
    async run<T = unknown>(): Promise<SqlResult<T>> {
      const r = await this.inner.run<T>();
      note(this.sql, r);
      return r;
    }
    async all<T = unknown>(): Promise<SqlResult<T>> {
      const r = await this.inner.all<T>();
      note(this.sql, r);
      return r;
    }
    first<T = unknown>(): Promise<T | null> {
      // `first()` carries no meta; nothing on the measured paths writes through it
      expect(writeTarget(this.sql), `a write through first(): ${this.sql}`).toBeNull();
      return this.inner.first<T>();
    }
  }
  return {
    db: {
      prepare: (sql: string) => new Stmt(sql, db.prepare(sql)),
      async batch<T = unknown>(stmts: SqlStatement[]): Promise<SqlResult<T>[]> {
        const s = stmts as Stmt[];
        const rs = await db.batch<T>(s.map((x) => x.inner));
        rs.forEach((r, i) => note(s[i]!.sql, r));
        return rs;
      },
    } as SqlDatabase,
    take() {
      const t = tally;
      tally = { written: {}, changed: {} };
      return t;
    },
  };
}

const total = (t: Tally) => Object.values(t.written).reduce((a, b) => a + b, 0);

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: SqlDatabase }>>>;
let raw: SqlDatabase;
let meter: ReturnType<typeof counting>;
let env: Env;
let tmp: string;

// A timestamp inside the ingest clamp window and in a fixed hourly bucket: warm-up and measurement land
// in the same port_stats bucket however long the suite takes.
const HOUR = Math.floor(Date.now() / 1000 / 3600) * 3600 - 2 * 3600;

type Pkt = { src: string; payload: string; port?: string; ts?: number; dst?: string };

async function ingest(packets: Pkt[]): Promise<void> {
  const res = await handleIngest(
    new Request("http://gw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "s" },
      body: JSON.stringify({
        packets: packets.map((p) => ({
          src: p.src,
          dst: p.dst ?? "APRS",
          path: ["WIDE1-1", "qAR", "OE3XIG"],
          payload: p.payload,
          heardVia: "aprs_is",
          igateCall: "OE3XIG",
          port: p.port ?? "aprs-is",
          ts: p.ts ?? HOUR + 60,
        })),
      }),
    }),
    env,
    { waitUntil: () => {} } as never,
  );
  expect(res.status).toBe(200);
}

/** Ingest once to warm the station, port and bucket, then measure a later packet of the same kind. */
async function steady(first: Pkt[], again: Pkt[] = first, after = 1): Promise<Tally> {
  await ingest(first);
  meter.take();
  await ingest(again.map((p) => ({ ...p, ts: (p.ts ?? HOUR + 60) + after })));
  return meter.take();
}

beforeAll(async () => {
  process.env.WRANGLER_SEND_METRICS = "false";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d1-writes-"));
  const config = path.join(tmp, "wrangler.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      name: "d1-writes",
      compatibility_date: "2026-04-07",
      d1_databases: [{ binding: "DB", database_name: "d1-writes", database_id: "d1-writes" }],
    }),
  );
  proxy = await getPlatformProxy<{ DB: SqlDatabase }>({ configPath: config, persist: false });
  raw = proxy.env.DB;
  for (const f of fs
    .readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    await raw.batch(unstable_splitSqlQuery(sql).map((q) => raw.prepare(q)));
  }
  meter = counting(raw);
  // the live WebSocket fan-out is out of scope: a room stub accepts and discards the deltas
  const room = { fetch: async () => new Response(null, { status: 204 }) };
  env = {
    DB: meter.db,
    INGEST_SECRET: "s",
    ROOMS: { idFromName: (n: string) => n, get: () => room },
  } as unknown as Env;
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const POS = "!4704.41N/01526.27E>mobile";
const POS_MOVED = "!4704.61N/01526.57E>mobile";

describe("D1 rows written per ingested packet", () => {
  it("a position fix from a station that has not moved is not stored", async () => {
    const t = await steady([{ src: "OE3POS", payload: POS }]);
    expect(t.written).toEqual({ packets_recent: 4, node_mheard: 2, port_stats: 1 });
    expect(total(t)).toBe(7);
  });

  it("a position fix from a station that has not moved, once the interval has passed", async () => {
    const t = await steady([{ src: "OE3INT", payload: POS }], undefined, 600);
    expect(t.written).toEqual({
      packets_recent: 4,
      positions: 4,
      stations: 1,
      account_stations: 0,
      node_mheard: 2,
      port_stats: 1,
    });
    expect(total(t)).toBe(12);
  });

  it("a position fix from a moving station", async () => {
    const t = await steady([{ src: "OE3MOV", payload: POS }], [{ src: "OE3MOV", payload: POS_MOVED }]);
    expect(t.written).toEqual({
      packets_recent: 4,
      positions: 4,
      stations: 2,
      account_stations: 0,
      node_mheard: 2,
      port_stats: 1,
    });
    expect(total(t)).toBe(13);
  });

  it("a position fix heard directly on RF, from a station that has not moved", async () => {
    const t = await steady([{ src: "OE3RF", payload: POS, port: "kiss-tnc" }]);
    expect(t.written).toEqual({
      packets_recent: 4,
      positions: 4,
      stations: 1,
      account_stations: 0,
      node_mheard: 2,
      port_stats: 1,
    });
    expect(total(t)).toBe(12);
  });

  it("a position fix from a protected station that has not moved", async () => {
    await raw
      .prepare(
        "INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('acct-2','OE3ACC',1,1)",
      )
      .run();
    const t = await steady([{ src: "OE3ACC-9", payload: POS }]);
    expect(t.written).toEqual({
      packets_recent: 4,
      positions: 4,
      stations: 1,
      account_stations: 0,
      node_mheard: 2,
      port_stats: 1,
    });
    expect(total(t)).toBe(12);
  });

  it("a position fix from a registered station that has not moved leaves its registry row alone", async () => {
    await raw
      .prepare(
        "INSERT INTO account_stations (account_id, callsign, lat, lon, created_at, updated_at) VALUES ('acct-1','OE3LOG',47,15,1,1)",
      )
      .run();
    const t = await steady([{ src: "OE3LOG", payload: POS }]);
    expect(t.written).toEqual({
      packets_recent: 4,
      positions: 4,
      stations: 1,
      account_stations: 0,
      node_mheard: 2,
      port_stats: 1,
    });
    expect(total(t)).toBe(12);
  });

  it("a position fix that moves a registered station updates its registry row", async () => {
    await raw
      .prepare(
        "INSERT INTO account_stations (account_id, callsign, lat, lon, created_at, updated_at) VALUES ('acct-1','OE3LGM',47,15,1,1)",
      )
      .run();
    const t = await steady([{ src: "OE3LGM", payload: POS }], [{ src: "OE3LGM", payload: POS_MOVED }]);
    expect(t.written).toEqual({
      packets_recent: 4,
      positions: 4,
      stations: 2,
      account_stations: 1,
      node_mheard: 2,
      port_stats: 1,
    });
    expect(total(t)).toBe(14);
  });

  it("a position fix from a station heard for the first time", async () => {
    await ingest([{ src: "OE3WRM", payload: POS }]); // the port and bucket exist; the station does not
    meter.take();
    await ingest([{ src: "OE3NEW", payload: POS }]);
    const t = meter.take();
    expect(t.written).toEqual({
      packets_recent: 4,
      positions: 4,
      stations: 3,
      account_stations: 0,
      node_mheard: 3,
      port_stats: 1,
    });
    expect(total(t)).toBe(15);
  });

  it("a message", async () => {
    const t = await steady([{ src: "OE3MSG", payload: ":OE3XYZ   :hello there{12" }]);
    expect(t.written).toEqual({ packets_recent: 4, messages: 3, node_mheard: 2, port_stats: 1 });
    expect(total(t)).toBe(10);
  });

  it("a positionless weather report", async () => {
    const t = await steady([{ src: "OE3WX", payload: "_10090556c220s004g005t077r000p000P000h50b09900wRSW" }]);
    expect(t.written).toEqual({ packets_recent: 4, sensor_readings: 2, node_mheard: 2, port_stats: 1 });
    expect(total(t)).toBe(9);
  });

  it("a weather report with a position, from a station that has not moved", async () => {
    const t = await steady([
      { src: "OE3WXP", payload: "@092345z4704.41N/01526.27E_220/004g005t077r000p000P000h50b09900" },
    ]);
    expect(t.written).toEqual({ packets_recent: 4, sensor_readings: 2, node_mheard: 2, port_stats: 1 });
    expect(total(t)).toBe(9);
  });

  it("a telemetry frame", async () => {
    const t = await steady([{ src: "OE3TLM", payload: "T#005,199,000,255,073,123,01100001" }]);
    expect(t.written).toEqual({ packets_recent: 4, node_mheard: 2, port_stats: 1 });
    expect(total(t)).toBe(7);
  });

  it("a status report", async () => {
    const t = await steady([{ src: "OE3STA", payload: ">on the air" }]);
    expect(t.written).toEqual({ packets_recent: 4, node_mheard: 2, port_stats: 1 });
    expect(total(t)).toBe(7);
  });

  it("a batch of five packets over two ports", async () => {
    const batch: Pkt[] = [
      { src: "OE3BA", payload: POS, port: "aprs-is" },
      { src: "OE3BB", payload: POS, port: "aprs-is" },
      { src: "OE3BC", payload: ">on the air", port: "aprs-is" },
      { src: "OE3BD", payload: POS, port: "kiss-tnc" },
      { src: "OE3BE", payload: "T#005,199,000,255,073,123,01100001", port: "kiss-tnc" },
    ];
    // the three fixes have not moved: the two APRS-IS ones are not stored, the TNC hearing is
    const t = await steady(batch);
    expect(t.written).toEqual({
      packets_recent: 20,
      positions: 4,
      stations: 1,
      account_stations: 0,
      node_mheard: 10,
      port_stats: 2,
    });
    expect(total(t)).toBe(37);
  });

  it("a station heard twice in one batch counts once in MHeard", async () => {
    const t = await steady([
      { src: "OE3TWO", payload: ">on the air" },
      { src: "OE3TWO", payload: ">still on the air" },
    ]);
    expect(t.written).toEqual({ packets_recent: 8, node_mheard: 2, port_stats: 1 });
    expect(total(t)).toBe(11);
    const row = await raw.prepare("SELECT count FROM node_mheard WHERE callsign = 'OE3TWO'").first<{ count: number }>();
    expect(row?.count).toBe(4);
  });
});

describe("D1 rows written per ingested packet over the daily write budget", () => {
  /** Rows the ingest handed to the budget's counter with its live dispatch. */
  let counted = 0;
  /** The same instance with its write budget spent: the live room answers `over` (budget.ts). */
  function overBudget(): Env {
    const over = () =>
      new Response(
        JSON.stringify({
          day: new Date().toISOString().slice(0, 10),
          used: 2_000_000,
          budget: 1_500_000,
          level: "over",
          alerts: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const room = {
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname === "/dispatch")
          counted += ((await req.json()) as { budget?: { add: number } }).budget?.add ?? 0;
        return over();
      },
    };
    return {
      DB: meter.db,
      INGEST_SECRET: "s",
      D1_DAILY_WRITE_BUDGET: "1500000",
      ROOMS: { idFromName: (n: string) => n, get: () => room },
    } as unknown as Env;
  }

  it("a position fix from a moving station that nothing protects writes no rows", async () => {
    const saved = env;
    try {
      await ingest([{ src: "OE3OVB", payload: POS }]); // under budget: the station exists
      env = overBudget();
      meter.take();
      await ingest([{ src: "OE3OVB", payload: POS_MOVED, ts: HOUR + 61 }]);
      expect(total(meter.take())).toBe(0);
    } finally {
      env = saved;
    }
  });

  it("a position fix from a protected station is stored as under budget, and the raw ring is paused", async () => {
    const saved = env;
    try {
      await raw
        .prepare(
          "INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('acct-3','OE3OVP',1,1)",
        )
        .run();
      await ingest([{ src: "OE3OVP", payload: POS }]);
      env = overBudget();
      meter.take();
      counted = 0;
      await ingest([{ src: "OE3OVP", payload: POS_MOVED, ts: HOUR + 61 }]);
      const t = meter.take();
      expect(t.written).toEqual({ positions: 4, stations: 2, account_stations: 0 });
      expect(total(t)).toBe(6);
      // the budget's counter is handed exactly the rows D1 reports written
      expect(counted).toBe(6);
    } finally {
      env = saved;
    }
  });
});

describe("D1 rows written by the nightly prune", () => {
  it("costs one written row per row it removes", async () => {
    // Ingest a known mix, then run the nightly job 31 days later, when every default retention has lapsed
    // and every ring row this suite wrote ages out.
    await ingest([
      { src: "OE3PRA", payload: POS },
      { src: "OE3PRB", payload: ":OE3XYZ   :prune me{13" },
      { src: "OE3PRC", payload: "_10090556c220s004g005t077r000p000P000h50b09900wRSW" },
    ]);
    const rings = ["positions", "packets_recent", "messages", "sensor_readings", "port_stats", "node_mheard"];
    const held: Record<string, number> = {};
    for (const r of rings) held[r] = (await raw.prepare(`SELECT COUNT(*) AS n FROM ${r}`).first<{ n: number }>())!.n;
    meter.take();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000);
      await runScheduled(env);
    } finally {
      vi.useRealTimers();
    }
    const t = meter.take();
    for (const r of rings) {
      expect(held[r], r).toBeGreaterThan(0);
      expect(t.changed[r], `${r} rows removed`).toBe(held[r]);
      expect(t.written[r], `${r} rows written per row removed`).toBe(held[r]);
    }
    // nothing else the nightly job touches writes a row on this database
    const others = Object.entries(t.written).filter(([k]) => !rings.includes(k));
    expect(
      others.every(([, n]) => n === 0),
      JSON.stringify(others),
    ).toBe(true);
  });
});
