// SPDX-License-Identifier: AGPL-3.0-or-later
// One transmission heard several times (over APRS-IS, directly on RF, again via a digipeater) is logged once,
// and the log keeps the RF route.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { handleIngest } from "@aprscaching/gateway/ingest";
import type { Env } from "@aprscaching/gateway/env";
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

async function ingest(env: Env, packets: unknown[]) {
  const res = await handleIngest(
    new Request("http://gw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "s" },
      body: JSON.stringify({ packets }),
    }),
    env,
    { waitUntil: () => {} } as never,
  );
  expect(res.status).toBe(200);
}

// the ingest clamps a timestamp to at most a minute ahead, so the tests run in the recent past
const T = Math.floor(Date.now() / 1000) - 2000;
const msg = (over: Record<string, unknown>) => ({
  src: "OE1ABC-7",
  dst: "APRS",
  path: [],
  payload: ":OE5XYZ   :see you at the cache{12",
  kind: "message",
  ts: T,
  ...over,
});
const viaIs = (ts = T) => msg({ ts, heardVia: "aprs_is", port: "aprs-is", path: ["TCPIP*", "qAC", "T2AUSTRIA"] });
const viaRf = (ts = T, p: string[] = []) => msg({ ts, heardVia: "rf", port: "kiss-tnc", path: p });

describe("duplicate packets", () => {
  it("logs a message heard over APRS-IS and on RF once, with the RF route", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [viaIs()]);
    await ingest(env, [viaRf(T + 3), viaRf(T + 5, ["OE8XDI*"])]);
    const rows = sqlite.prepare("SELECT body, transport FROM messages").all();
    expect(rows).toEqual([{ body: "see you at the cache", transport: "tnc" }]);
    const raw = sqlite.prepare("SELECT heard_via, port, path FROM packets_recent").all();
    expect(raw).toEqual([{ heard_via: "rf", port: "kiss-tnc", path: "" }]);
  });

  it("logs the same text again once 30 seconds have passed", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [viaRf(T), viaRf(T + 31)]);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM packets_recent").get() as { n: number }).n).toBe(2);
  });

  it("keeps the RF copy when both arrive in one batch", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [viaIs(), viaRf(T + 1)]);
    expect(sqlite.prepare("SELECT transport FROM messages").all()).toEqual([{ transport: "tnc" }]);
  });
});
