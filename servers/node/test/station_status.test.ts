// SPDX-License-Identifier: AGPL-3.0-or-later
// The operator's station summary against real SQLite: sysop or operator secret only, stations heard in
// the last hour, per-port counters and last hearing, and received messages for the operator's own calls.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { handleStationStatus, type StationStatus } from "@aprscaching/gateway/station_status";
import type { Env } from "@aprscaching/gateway/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const SECRET = "operator-secret-for-tests-0123456789";

let sqlite: Database.Database;
let env: Env;
let now: number;

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  env = { DB: makeD1(sqlite), ADMIN_CALLSIGNS: "OE8APR", OPERATOR_SECRET: SECRET } as unknown as Env;
  now = Math.floor(Date.now() / 1000);
  const st = sqlite.prepare("INSERT INTO stations (callsign, lat, lon, last_seen) VALUES (?,47,15,?)");
  st.run("OE8AAA", now - 60);
  st.run("OE8BBB", now - 1800);
  st.run("OE8OLD", now - 7200);
  const bucket = Math.floor(now / 3600) * 3600;
  sqlite
    .prepare("INSERT INTO port_stats (port, ts, rx, tx) VALUES ('meshcom', ?, 4, 0), ('aprs-is', ?, 90, 0)")
    .run(bucket, bucket);
  sqlite.prepare("INSERT INTO port_stats (port, ts, rx, tx) VALUES ('aprs-is', ?, 1000, 0)").run(bucket - 5 * 3600);
  const pk = sqlite.prepare(
    "INSERT INTO packets_recent (callsign, ts, dst, path, payload, heard_via, port) VALUES (?,?,'APRS','',':x',?,?)",
  );
  pk.run("OE8APR-12", now - 30, "rf", "meshcom");
  pk.run("OE8AAA", now - 5, "aprs_is", "aprs-is");
  const msg = sqlite.prepare(
    "INSERT INTO messages (ts, from_call, to_call, body, ack, direction) VALUES (?,?,?,?,NULL,?)",
  );
  msg.run(now - 100, "OE8XYZ", "OE8APR-7", "hello", "rx");
  msg.run(now - 50, "OE8XYZ", "OE8APR", "second", "rx");
  msg.run(now - 40, "OE8APR", "OE8XYZ", "my reply", "tx");
  msg.run(now - 30, "OE8XYZ", "OE8APRX", "not mine", "rx");
  msg.run(now - 20, "OE8XYZ", "OE5OTH", "someone else", "rx");
  msg.run(now - 90000, "OE8XYZ", "OE8APR", "too old", "rx");
});

async function status(headers: Record<string, string>, query = ""): Promise<Response> {
  return handleStationStatus(new Request(`http://127.0.0.1/api/admin/station-status${query}`, { headers }), env);
}

describe("station status", () => {
  it("says whether the operator's call is control-verified", async () => {
    let s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.operatorVerified).toBe(false);
    sqlite
      .prepare(
        "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8APR', 'operator', 'verified', ?)",
      )
      .run(now);
    s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.operatorVerified).toBe(true);
  });

  it("reports the own MeshCom node's Via setting from its own messages only, unknown until one is seen", async () => {
    const row = sqlite.prepare(
      "INSERT OR REPLACE INTO meshcom_nodes (callsign, last_heard, last_via, sent_via, msg_at, updated_at) VALUES (?,?,?,?,?,?)",
    );
    row.run("OE8APR-12", now, "node", null, null, now); // heard only by its position so far
    row.run("OE3XYZ-1", now, "direct", '["OE1KBC-24"]', now, now); // another station's via list
    let s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.meshcomVia).toEqual([{ node: "OE8APR-12", state: "unknown", relays: [] }]);
    row.run("OE8APR-12", now, "node", '["OE1KBC-24","OE1KFR-12"]', now, now);
    s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.meshcomVia).toEqual([{ node: "OE8APR-12", state: "on", relays: ["OE1KBC-24", "OE1KFR-12"] }]);
    row.run("OE8APR-12", now, "node", null, now, now);
    s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.meshcomVia).toEqual([{ node: "OE8APR-12", state: "off", relays: [] }]);
    sqlite.prepare("DELETE FROM meshcom_nodes").run();
  });

  it("answers only the operator", async () => {
    expect((await status({})).status).toBe(403);
    expect((await status({ "x-operator-secret": "wrong" })).status).toBe(401);
    expect((await status({ "x-ingest-secret": SECRET })).status).toBe(403);
    expect((await status({ "x-operator-secret": SECRET })).status).toBe(200);
  });

  it("counts the stations heard in the last hour", async () => {
    const s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.stationsLastHour).toBe(2);
  });

  it("reports each port's recent packets and when it last heard anything", async () => {
    const s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.ports).toEqual([
      { port: "aprs-is", rxRecent: 90, lastHeard: now - 5 },
      { port: "meshcom", rxRecent: 4, lastHeard: now - 30 },
    ]);
  });

  it("lists received messages to any SSID of the operator's calls, oldest first", async () => {
    const s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.messages.map((m) => [m.from, m.to, m.body])).toEqual([
      ["OE8XYZ", "OE8APR-7", "hello"],
      ["OE8XYZ", "OE8APR", "second"],
    ]);
  });

  it("leaves out messages to the service call: players' commands, which the instance answers itself", async () => {
    sqlite
      .prepare("INSERT INTO messages (ts, from_call, to_call, body, ack, direction) VALUES (?,?,?,?,NULL,'rx')")
      .run(now - 10, "OE5XYZ-7", "OE8APR-15", "FOUND AC-0001");
    const s = (await (await status({ "x-operator-secret": SECRET })).json()) as StationStatus;
    expect(s.messages.map((m) => m.body)).not.toContain("FOUND AC-0001");
    expect(s.messages.map((m) => m.body)).toContain("hello");
  });

  it("returns only messages after `since`, and never older than a week", async () => {
    let s = (await (await status({ "x-operator-secret": SECRET }, `?since=${now - 60}`)).json()) as StationStatus;
    expect(s.messages.map((m) => m.body)).toEqual(["second"]);
    s = (await (await status({ "x-operator-secret": SECRET }, "?since=1")).json()) as StationStatus;
    expect(s.messages.map((m) => m.body)).toEqual(["too old", "hello", "second"]);
    sqlite.prepare("UPDATE messages SET ts = ? WHERE body = 'too old'").run(now - 8 * 86400);
    s = (await (await status({ "x-operator-secret": SECRET }, "?since=1")).json()) as StationStatus;
    expect(s.messages.map((m) => m.body)).toEqual(["hello", "second"]);
  });
});
