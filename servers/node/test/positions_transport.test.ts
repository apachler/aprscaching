// SPDX-License-Identifier: AGPL-3.0-or-later
// Every position records how it reached the gateway: the schema requires a transport, and the ingest
// stores one for every ingest port (`unknown` for a port it does not know).
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { handleIngest } from "@aprscaching/gateway/ingest";
import type { Env } from "@aprscaching/gateway/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

describe("positions.transport", () => {
  it("a position without a transport is refused", () => {
    const db = new Database(":memory:");
    migrate(db, MIGRATIONS);
    expect(() =>
      db.prepare("INSERT INTO positions (callsign, ts, lat, lon, heard_via) VALUES ('OE3NUL', 1, 47, 15, 'rf')").run(),
    ).toThrow(/NOT NULL/);
  });

  it("the ingest stores the transport of each port", async () => {
    const sqlite = new Database(":memory:");
    migrate(sqlite, MIGRATIONS);
    // the live WebSocket fan-out is out of scope here: a room stub accepts and discards the deltas
    const room = { fetch: async () => new Response(null, { status: 204 }) };
    const ROOMS = { get: () => room };
    const env = { DB: makeD1(sqlite), INGEST_SECRET: "s", ROOMS } as unknown as Env;
    const ports = ["aprs-is", "kiss-tnc", "agwpe", "hostmode", "axudp", "axip", "meshcom", "meshtastic", "made-up"];
    const now = Math.floor(Date.now() / 1000);
    const packets = ports.map((port, i) => ({
      src: `OE3T${String.fromCharCode(65 + i)}`,
      dst: "APRS",
      path: [],
      payload: "!4704.41N/01526.27E>",
      kind: "position",
      heardVia: "rf",
      port,
      ts: now,
    }));
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
    const rows = sqlite.prepare("SELECT callsign, transport FROM positions ORDER BY callsign").all() as {
      callsign: string;
      transport: string;
    }[];
    expect(rows.map((r) => r.transport)).toEqual([
      "aprs-is",
      "tnc",
      "tnc",
      "tnc",
      "axudp",
      "axip",
      "meshcom",
      "meshtastic",
      "unknown",
    ]);
  });
});
