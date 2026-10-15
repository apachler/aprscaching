// SPDX-License-Identifier: AGPL-3.0-or-later
// An ingest posts an info field one character per byte. Text a station sent as UTF-8 is stored and shown
// as UTF-8; text in another 8-bit character set keeps one character per byte.
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

/** The info field as the ingest posts it: the bytes heard, one character per byte. */
const bytes = (text: string, enc: BufferEncoding = "utf8") => Buffer.from(text, enc).toString("latin1");

const T = Math.floor(Date.now() / 1000) - 2000;
const rf = (payload: string, ts = T) => ({
  src: "OE8ABC-7",
  dst: "APRS",
  path: [],
  payload,
  heardVia: "rf",
  port: "kiss-tnc",
  ts,
});
const is = (payload: string, ts = T) => ({
  ...rf(payload, ts),
  heardVia: "aprs_is",
  port: "aprs-is",
  path: ["TCPIP*", "qAC", "T2AUSTRIA"],
});

describe("text heard on RF", () => {
  it("stores a UTF-8 message as UTF-8", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [rf(bytes(":OE5XYZ   :Grüße vom Cache{7"))]);
    expect(sqlite.prepare("SELECT body FROM messages").all()).toEqual([{ body: "Grüße vom Cache" }]);
    expect(sqlite.prepare("SELECT payload FROM packets_recent").all()).toEqual([
      { payload: ":OE5XYZ   :Grüße vom Cache{7" },
    ]);
  });

  it("keeps a Latin-1 message one character per byte", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [rf(bytes(":OE5XYZ   :Grüße{8", "latin1"))]);
    expect(sqlite.prepare("SELECT body FROM messages").all()).toEqual([{ body: "Grüße" }]);
  });

  it("stores a UTF-8 status and position comment as UTF-8", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [rf(bytes(">Unterwegs zum Großglockner")), rf(bytes("!4703.50N/01242.00E>Fahrt über Land"))]);
    expect(sqlite.prepare("SELECT payload FROM packets_recent ORDER BY id").all()).toEqual([
      { payload: ">Unterwegs zum Großglockner" },
      { payload: "!4703.50N/01242.00E>Fahrt über Land" },
    ]);
    expect(sqlite.prepare("SELECT comment FROM stations").all()).toEqual([{ comment: "Fahrt über Land" }]);
  });

  it("logs one message heard on RF and over APRS-IS once", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [is(bytes(":OE5XYZ   :Grüße{9"))]);
    await ingest(env, [rf(bytes(":OE5XYZ   :Grüße{9"), T + 3)]);
    expect(sqlite.prepare("SELECT body, transport FROM messages").all()).toEqual([{ body: "Grüße", transport: "tnc" }]);
  });
});
