// SPDX-License-Identifier: AGPL-3.0-or-later
// A licensee who objects to the processing of their station's on-air data is excluded by the sysop: the station's
// stored rows are purged, every later frame of it is dropped before it is stored or fanned out, and another
// station's frame that names it in its path stays. Accounts are untouched, and only the sysop reaches the list.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;

interface World {
  env: Env;
  sysop: Res;
  dispatched: unknown[];
}

async function world(): Promise<World> {
  const dispatched: unknown[] = [];
  const room = {
    fetch: async (r: Request) => {
      dispatched.push(...((await r.json()) as { envelopes: unknown[] }).envelopes);
      return new Response(null, { status: 204 });
    },
  };
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", ROOMS: { get: () => room } });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  return { env, sysop, dispatched };
}

const T = Math.floor(Date.now() / 1000) - 600;
const pos = (src: string, over: Record<string, unknown> = {}) => ({
  src,
  dst: "APRS",
  path: ["WIDE1-1"],
  payload: "!4704.00N/01525.00E>moving",
  ts: T,
  heardVia: "rf",
  port: "kiss-tnc",
  ...over,
});

async function ingest(env: Env, packets: unknown[]): Promise<Res> {
  const r = await call(env, "POST", "/ingest", { packets }, { "x-ingest-secret": "test-ingest-secret" });
  expect(r.status).toBe(200);
  return r;
}

const count = async (env: Env, sql: string) => Number((await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0);

const exclude = (w: World, callsign: string, category = "objection", headers: Record<string, string> | null = null) =>
  call(w.env, "POST", "/api/admin/exclusions", { callsign, category }, headers ?? { cookie: w.sysop.cookie });

describe("station exclusion", () => {
  it("purges the station's rows under every SSID, and keeps other stations and the aggregates", async () => {
    const w = await world();
    await ingest(w.env, [
      pos("OE1ABC-9"),
      pos("OE1ABC", { payload: ":OE5XYZ   :hello{1", ts: T + 1 }),
      pos("OE1ABC-13", { payload: "_10090556c220s004g005t077r000p000P000h50b09900", ts: T + 2 }),
      pos("OE5XYZ", { payload: ":OE1ABC   :hi there{2", ts: T + 3 }),
      pos("OE5XYZ", { path: ["OE1ABC-1*", "WIDE2-1"], ts: T + 4 }),
    ]);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM stations WHERE callsign LIKE 'OE1ABC%'")).toBe(1);

    const preview = await call(w.env, "GET", "/api/admin/exclusions/oe1abc-9", undefined, { cookie: w.sysop.cookie });
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ callsign: "OE1ABC", excluded: false, held: false });
    expect(preview.data.counts).toMatchObject({ stations: 1, positions: 1, packets: 3, messages: 1, weather: 1 });
    expect(preview.data.counts.mheard).toBeGreaterThan(0);

    const r = await exclude(w, "OE1ABC-9");
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ callsign: "OE1ABC", category: "objection", held: false });
    expect(r.data.purged.packets).toBe(3);

    for (const [table, col] of [
      ["stations", "callsign"],
      ["positions", "callsign"],
      ["packets_recent", "callsign"],
      ["sensor_readings", "station"],
      ["node_mheard", "callsign"],
      ["messages", "from_call"],
    ])
      expect(await count(w.env, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} LIKE 'OE1ABC%'`), table).toBe(0);
    // another station's message to it and its packet through it are that station's
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM messages WHERE to_call = 'OE1ABC'")).toBe(1);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM packets_recent WHERE path LIKE 'OE1ABC-1*%'")).toBe(1);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM stations WHERE callsign = 'OE5XYZ'")).toBe(1);
    expect(await count(w.env, "SELECT COALESCE(SUM(rx), 0) AS n FROM port_stats")).toBe(5);

    const log = await call(w.env, "GET", "/api/admin/moderation/log", undefined, { cookie: w.sysop.cookie });
    expect(log.data.entries[0]).toMatchObject({ action: "exclude", kind: "station", targetId: "OE1ABC" });
  });

  it("stores and fans out nothing the station sends later, while others are heard", async () => {
    const w = await world();
    expect((await exclude(w, "OE1ABC")).status).toBe(201);
    w.dispatched.length = 0;
    const r = await ingest(w.env, [
      pos("OE1ABC-7"),
      pos("OE1ABC", { payload: ":OE8APR   :are you there{3", ts: T + 1 }),
      pos("OE8XDI", { payload: "}OE1ABC-9>APRS,TCPIP,OE8XDI*:!4704.00N/01525.00E>relayed", ts: T + 2 }),
      pos("OE5XYZ", { ts: T + 3 }),
    ]);
    expect(r.data.stored).toBe(1);
    for (const table of ["positions", "packets_recent", "stations", "node_mheard"])
      expect(await count(w.env, `SELECT COUNT(*) AS n FROM ${table} WHERE callsign LIKE 'OE1ABC%'`), table).toBe(0);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM packets_recent WHERE callsign = 'OE8XDI'")).toBe(0);
    expect(await count(w.env, "SELECT COALESCE(SUM(rx), 0) AS n FROM port_stats")).toBe(4);
    expect(JSON.stringify(w.dispatched)).not.toContain("OE1ABC");
    expect(JSON.stringify(w.dispatched)).toContain("OE5XYZ");
    // the heard feed has nothing of it
    const heard = await call(w.env, "GET", "/api/v1/station/OE1ABC-7/heard");
    expect(JSON.stringify(heard.data ?? {})).not.toContain("moving");

    // lifted, the station is heard again
    const lift = await call(w.env, "DELETE", "/api/admin/exclusions/OE1ABC", undefined, { cookie: w.sysop.cookie });
    expect(lift.status).toBe(200);
    await ingest(w.env, [pos("OE1ABC-7", { ts: T + 10 })]);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM stations WHERE callsign = 'OE1ABC-7'")).toBe(1);
  });

  it("leaves an account holding the call alone, and says so", async () => {
    const w = await world();
    const member = await emailSignup(w.env, "m@example.test", "OE1ABC", nextIp());
    expect(member.status).toBe(200);
    const preview = await call(w.env, "GET", "/api/admin/exclusions/OE1ABC", undefined, { cookie: w.sysop.cookie });
    expect(preview.data.held).toBe(true);
    const r = await exclude(w, "OE1ABC");
    expect(r.status).toBe(201);
    expect(r.data.held).toBe(true);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM account_callsigns WHERE callsign = 'OE1ABC'")).toBe(1);
    const list = await call(w.env, "GET", "/api/admin/exclusions", undefined, { cookie: w.sysop.cookie });
    expect(list.data.exclusions).toEqual([
      { callsign: "OE1ABC", category: "objection", createdAt: expect.any(Number), createdBy: "OE8APR", held: true },
    ]);
  });

  it("refuses a duplicate, the service call, a bad category and a bad call", async () => {
    const w = await world();
    expect((await exclude(w, "OE1ABC")).status).toBe(201);
    expect((await exclude(w, "OE1ABC-5")).status).toBe(409);
    expect((await exclude(w, "OE8APR")).status).toBe(409);
    expect((await exclude(w, "OE1XYZ", "because")).status).toBe(400);
    expect((await exclude(w, "not a call")).status).toBe(400);
    const gone = await call(w.env, "DELETE", "/api/admin/exclusions/OE1XYZ", undefined, { cookie: w.sysop.cookie });
    expect(gone.status).toBe(404);
  });

  it("is the sysop's alone: a member and an anonymous caller get 403 and change nothing", async () => {
    const w = await world();
    const member = await emailSignup(w.env, "m@example.test", "DL1USR", nextIp());
    await ingest(w.env, [pos("OE1ABC")]);
    const callers: Record<string, string>[] = [{ cookie: member.cookie }, {}];
    for (const h of callers) {
      expect((await call(w.env, "GET", "/api/admin/exclusions", undefined, h)).status).toBe(403);
      expect((await call(w.env, "GET", "/api/admin/exclusions/OE1ABC", undefined, h)).status).toBe(403);
      expect((await exclude(w, "OE1ABC", "objection", h)).status).toBe(403);
      expect((await call(w.env, "DELETE", "/api/admin/exclusions/OE1ABC", undefined, h)).status).toBe(403);
    }
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM excluded_calls")).toBe(0);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM stations WHERE callsign = 'OE1ABC'")).toBe(1);
    // a script reaches it with the operator secret
    const scripted = await exclude(w, "OE1ABC", "erasure", { "x-operator-secret": "test-operator-secret" });
    expect(scripted.status).toBe(201);
    expect(await count(w.env, "SELECT COUNT(*) AS n FROM excluded_calls WHERE created_by IS NULL")).toBe(1);
  });
});
