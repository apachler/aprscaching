// SPDX-License-Identifier: AGPL-3.0-or-later
// Each port's health against real SQLite: the ingest box's reports add up in the port's hourly bucket, the
// transports list shows the sums beside the RX count, and a rate counts only while its report is recent.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { handleIngest } from "@aprscaching/gateway/ingest";
import { handlePorts } from "@aprscaching/gateway/shack";
import type { Env } from "@aprscaching/gateway/env";
import type { PortStat } from "@aprscaching/shared";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

function setup() {
  const sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  const room = { fetch: async () => new Response(null, { status: 204 }) };
  const env = { DB: makeD1(sqlite), INGEST_SECRET: "s", ROOMS: { get: () => room } } as unknown as Env;
  return { sqlite, env };
}

async function ingest(env: Env, body: unknown) {
  const res = await handleIngest(
    new Request("http://gw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "s" },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {} } as never,
  );
  expect(res.status).toBe(200);
}

async function ports(env: Env): Promise<PortStat[]> {
  const res = await handlePorts(new Request("http://gw/api/ports"), env);
  return ((await res.json()) as { ports: PortStat[] }).ports;
}

const T = Math.floor(Date.now() / 1000) - 60;
const pos = {
  src: "OE1ABC-7",
  dst: "APRS",
  path: [],
  payload: "!4703.50N/01530.00E>",
  heardVia: "rf",
  port: "kiss-tnc",
  ts: T,
};

describe("port health", () => {
  it("adds each report to the port's bucket and shows the sums with the latest rate", async () => {
    const { env } = setup();
    await ingest(env, { packets: [pos], ports: [{ port: "kiss-tnc", heard: 10, parsed: 8, invalid: 2, pps: 0.2 }] });
    // a report on its own, with no packets: a port whose frames all failed still reports
    await ingest(env, { packets: [], ports: [{ port: "kiss-tnc", heard: 5, parsed: 5, invalid: 0, pps: 0.1 }] });
    const list = await ports(env);
    expect(list).toEqual([
      expect.objectContaining({ port: "kiss-tnc", rx: 1, heard: 15, parsed: 13, invalid: 2, pps: 0.1 }),
    ]);
  });

  it("shows no rate for a port whose last report is stale, and zeros for a port with none", async () => {
    const { sqlite, env } = setup();
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / 3600) * 3600;
    sqlite
      .prepare(
        "INSERT INTO port_stats (port, ts, rx, tx, heard, parsed, invalid, pps, pps_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run("lora-aprs", bucket, 3, 0, 4, 3, 1, 0.5, now - 3600);
    sqlite.prepare("INSERT INTO port_stats (port, ts, rx, tx) VALUES ('aprs-is', ?, 9, 0)").run(bucket);
    const list = await ports(env);
    expect(list.find((p) => p.port === "lora-aprs")).toMatchObject({ heard: 4, invalid: 1, pps: null });
    expect(list.find((p) => p.port === "aprs-is")).toMatchObject({ rx: 9, heard: 0, parsed: 0, invalid: 0, pps: null });
  });

  it("keeps a report's parsed and invalid counts within what the port heard", async () => {
    const { env } = setup();
    await ingest(env, { packets: [], ports: [{ port: "aprs-is", heard: 2, parsed: 9, invalid: 9, pps: 0 }] });
    expect((await ports(env))[0]).toMatchObject({ heard: 2, parsed: 2, invalid: 2 });
  });
});
