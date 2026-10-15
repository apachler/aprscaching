// SPDX-License-Identifier: AGPL-3.0-or-later
// A station's detail names the device behind its last stored position, from the device database the gateway
// fetched from DEVICEID_URL: by tocall for an ordinary packet, by the Mic-E device code for a Mic-E one. Without
// DEVICEID_URL nothing is fetched and no device is named.
import { describe, it, expect } from "vitest";
import { refreshDeviceIds } from "@aprscaching/gateway/deviceid";
import { runScheduled } from "@aprscaching/gateway/app";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const URL_ = "https://deviceid.test/tocalls.dense.json";
const now = () => Math.floor(Date.now() / 1000);
const room = { fetch: async () => new Response(null, { status: 204 }) };

// a hand-written table in the database's shape; the tests never read the real data
const TABLE = {
  classes: { software: { shown: "Desktop software" }, rig: { shown: "Rig" } },
  tocalls: { "APDW??": { vendor: "WB2OSZ", model: "Dire Wolf", class: "software" } },
  mice: {},
  micelegacy: { "]=": { vendor: "Kenwood", model: "TM-D710", class: "rig", prefix: "]", suffix: "=" } },
};

function server(body: unknown = TABLE) {
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: '"t1"' } });
  }) as unknown as typeof fetch;
  return { f, seen };
}

async function ingest(env: Env, src: string, dst: string, payload: string) {
  const res = await call(
    env,
    "POST",
    "/ingest",
    { packets: [{ src, dst, path: [], payload, kind: "position", heardVia: "aprs_is", ts: now() - 30 }] },
    INGEST,
  );
  expect(res.status, JSON.stringify(res.data)).toBe(200);
}

const detail = async (env: Env, cs: string) => (await call(env, "GET", `/api/stations/${cs}`)).data.station;

describe("the device on a station's detail", () => {
  it("names the device by tocall, and a Mic-E one by its device code", async () => {
    const env = authEnv({ DEVICEID_URL: URL_, ROOMS: { get: () => room } });
    const s = server();
    await refreshDeviceIds(env, s.f);
    expect(s.seen).toEqual([URL_]);
    await ingest(env, "OE8DW-10", "APDW17", "!4704.41N/01526.27E#digi");
    expect((await detail(env, "OE8DW-10")).device).toEqual({
      name: "Dire Wolf",
      vendor: "WB2OSZ",
      class: "Desktop software",
    });
    // the Mic-E destination is position data; only the ]…= code names the radio
    await ingest(env, "OE8KW-9", "S32U6T", '`(_fn"Oj/]"4T}Mobile=');
    const kw = await detail(env, "OE8KW-9");
    expect(kw.device).toEqual({ name: "TM-D710", vendor: "Kenwood", class: "Rig" });
    expect(kw).not.toHaveProperty("tocall");
  });

  it("names nothing it does not know", async () => {
    const env = authEnv({ DEVICEID_URL: URL_, ROOMS: { get: () => room } });
    await refreshDeviceIds(env, server().f);
    await ingest(env, "OE8XX-1", "APZZZZ", "!4704.41N/01526.27E>");
    expect((await detail(env, "OE8XX-1")).device).toBeNull();
  });

  it("fetches nothing and names nothing without DEVICEID_URL", async () => {
    const env = authEnv({ ROOMS: { get: () => room } });
    const s = server();
    await refreshDeviceIds(env, s.f);
    expect(s.seen).toEqual([]);
    await ingest(env, "OE8DW-10", "APDW17", "!4704.41N/01526.27E#digi");
    expect((await detail(env, "OE8DW-10")).device).toBeNull();
  });

  it("keeps the nightly task off the network without DEVICEID_URL", async () => {
    const env = authEnv({ UPDATE_CHECK: "0", ROOMS: { get: () => room } });
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    try {
      await runScheduled(env);
    } finally {
      globalThis.fetch = real;
    }
    expect(seen.filter((u) => u.includes("deviceid") || u.includes("tocalls"))).toEqual([]);
  });
});
