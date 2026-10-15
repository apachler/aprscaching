// SPDX-License-Identifier: AGPL-3.0-or-later
// A Maidenhead locator leading a status report or Mic-E status text shows on the station's detail as its grid
// square. It is never a position fix: no position row, no move of the station, and the person's export carries it
// with the rest of what the instance heard of their calls.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000);
const room = { fetch: async () => new Response(null, { status: 204 }) };

async function ingest(env: Env, src: string, dst: string, payload: string, ago = 30) {
  const res = await call(
    env,
    "POST",
    "/ingest",
    { packets: [{ src, dst, path: [], payload, kind: "other", heardVia: "aprs_is", ts: now() - ago }] },
    INGEST,
  );
  expect(res.status, JSON.stringify(res.data)).toBe(200);
}

const detail = async (env: Env, cs: string) => call(env, "GET", `/api/stations/${cs}`);
const positions = async (env: Env, cs: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE callsign = ?").bind(cs).first<{ n: number }>())!.n;

describe("the locator on a station's detail", () => {
  it("shows the grid of a status report and writes no position", async () => {
    const env = authEnv({ ROOMS: { get: () => room } });
    await ingest(env, "OE8LOC-9", "APRS", "!4704.41N/01526.27E>on the road", 60);
    await ingest(env, "OE8LOC-9", "APRS", ">JN76TO/- QRV 145.500");
    const s = (await detail(env, "OE8LOC-9")).data.station;
    expect(s.locator).toBe("JN76TO");
    // the station stays where its position report put it, and its track holds that report alone
    expect(s).toMatchObject({ lat: 47.0735, comment: "on the road" });
    expect(s.track).toHaveLength(1);
    expect(await positions(env, "OE8LOC-9")).toBe(1);
  });

  it("keeps the grid of a Mic-E status text beside the Mic-E position", async () => {
    const env = authEnv({ ROOMS: { get: () => room } });
    await ingest(env, "OE8MIC-9", "S32U6T", '`(_fn"Oj/]IO91SX/G Hello=');
    const s = (await detail(env, "OE8MIC-9")).data.station;
    expect(s.locator).toBe("IO91SX");
    expect(s.comment).toBe("Hello");
    expect(await positions(env, "OE8MIC-9")).toBe(1);
  });

  it("keeps no station for a status report alone", async () => {
    const env = authEnv({ ROOMS: { get: () => room } });
    await ingest(env, "OE8ONLY-1", "APRS", ">JN76TO/- QRV");
    expect((await detail(env, "OE8ONLY-1")).status).toBe(404);
    expect(await positions(env, "OE8ONLY-1")).toBe(0);
  });

  it("shows no grid for a station that sent none", async () => {
    const env = authEnv({ ROOMS: { get: () => room } });
    await ingest(env, "OE8NOG-9", "APRS", "!4704.41N/01526.27E>");
    await ingest(env, "OE8NOG-9", "APRS", ">just a status");
    expect((await detail(env, "OE8NOG-9")).data.station.locator).toBeNull();
  });

  it("is in the person's export", async () => {
    const env = authEnv({ ROOMS: { get: () => room } });
    const p = await emailSignup(env, "dl1loc@example.test", "DL1LOC", "198.51.100.77");
    expect(p.status).toBe(200);
    await ingest(env, "DL1LOC-7", "APRS", "!4704.41N/01526.27E>", 60);
    await ingest(env, "DL1LOC-7", "APRS", ">JN76TO/- QRV");
    const exp = await call(env, "POST", "/api/account/DL1LOC/export", {}, { cookie: p.cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.heardStations).toEqual([expect.objectContaining({ callsign: "DL1LOC-7", locator: "JN76TO" })]);
  });
});
