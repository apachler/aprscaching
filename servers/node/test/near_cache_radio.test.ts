// SPDX-License-Identifier: AGPL-3.0-or-later
// The "you're near" radio message: an opted-in player's own station heard on foot near a cache gets a short
// APRS message from the service call, within the per-cache and per-hour limits, back the way it was heard.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";
import { decideRadioCommand } from "@aprscaching/gateway/radiolog";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "test-ingest-secret";
const SITE = "OE8XXX-10";
/** 47°04.20'N 15°25.20'E: the first cache. */
const CACHE = { lat: 47.07, lon: 15.42 };
/** The player's beacon, about 37 m south of the cache. */
const AT = "4704.18N/01525.20E";

interface Packet {
  src: string;
  payload: string;
  port?: string;
  heardVia?: string;
  igateCall?: string;
  path?: string[];
  box?: string;
  rxCall?: string;
}

async function ingest(env: Env, p: Packet) {
  const r = await call(
    env,
    "POST",
    "/ingest",
    {
      packets: [
        {
          dst: "APRS",
          path: ["TCPIP*", "qAC", "T2TEST"],
          heardVia: "aprs_is",
          igateCall: "T2TEST",
          port: "aprs-is",
          ts: Math.floor(Date.now() / 1000),
          ...p,
        },
      ],
    },
    { "x-ingest-secret": SECRET },
  );
  expect(r.status).toBe(200);
}

/** A position beacon over APRS-IS; `speed` in knots, none when undefined. */
const beacon = (env: Env, src = "OE1ABC-7", speed?: number) =>
  ingest(env, {
    src,
    payload: `!${AT}>${speed === undefined ? "" : `090/${String(speed).padStart(3, "0")}`}`,
  });

const outbox = async (env: Env) =>
  (
    await env.DB.prepare("SELECT src_call, payload FROM aprs_outbox ORDER BY id").all<{
      src_call: string;
      payload: string;
    }>()
  ).results;

async function addCache(env: Env, code: string, title: string, lat = CACHE.lat, lon = CACHE.lon, owner = "OE3OWN") {
  const t = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES (?,?,?, 'traditional', ?,?,?,?)",
  )
    .bind(code, owner, title, lat, lon, t, t)
    .run();
  return Number(r.meta?.last_row_id);
}

async function player(opts: { on?: boolean; verified?: boolean } = {}) {
  // the live WebSocket fan-out is out of scope here: a room stub accepts and discards the envelopes
  const room = { fetch: async () => new Response(null, { status: 204 }) };
  const ROOMS = { get: () => room };
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR,OE1ABC", INGEST_SECRET: SECRET, FIRST_PARTY_SITES: SITE, ROOMS });
  const me = await emailSignup(env, "near@example.test", "OE1ABC");
  if (opts.verified !== false) await operatorVerify(env, "OE1ABC");
  const setting = (on?: boolean) =>
    call(env, "POST", "/api/near-radio", on === undefined ? {} : { on }, { cookie: me.cookie });
  if (opts.on) expect((await setting(true)).data).toEqual({ on: true });
  await addCache(env, "AC-0001", "Landhaus courtyard");
  return { env, me, setting };
}

const nearMessages = (rows: { payload: string }[]) => rows.filter((r) => r.payload.includes(":Near "));

describe("the near-cache radio message", () => {
  it("is off by default: a player heard at a cache gets nothing", async () => {
    const { env, me } = await player();
    expect((await call(env, "GET", "/api/near-radio", undefined, { cookie: me.cookie })).data).toEqual({ on: false });
    await beacon(env);
    expect(await outbox(env)).toEqual([]);
  });

  it("is switched in the web API and then sent once per cache, from the service call, numbered", async () => {
    const { env, me, setting } = await player();
    expect((await call(env, "POST", "/api/near-radio", { on: true })).status).toBe(401);
    expect((await setting()).status).toBe(400);
    expect((await setting(true)).data).toEqual({ on: true });
    await beacon(env);
    const [sent] = await outbox(env);
    expect(sent?.src_call).toBe("OE8APR-15");
    expect(sent?.payload).toMatch(
      /^:OE1ABC-7 :Near AC-0001 Landhaus courtyard 3\dm N\. Reply FOUND AC-0001\{N[0-9A-Z]{4}$/,
    );
    // the same cache again: within the day, nothing more
    await beacon(env, "OE1ABC-9");
    expect(await outbox(env)).toHaveLength(1);
    // the station's ack is recorded
    const msgNo = /\{(N[0-9A-Z]{4})$/.exec(sent!.payload)![1];
    await ingest(env, { src: "OE1ABC-7", payload: `:OE8APR-15:ack${msgNo}` });
    const row = await env.DB.prepare("SELECT acked_at FROM near_cache_messages").first<{ acked_at: number | null }>();
    expect(row?.acked_at).toBeGreaterThan(0);
    expect((await setting(false)).data).toEqual({ on: false });
    expect((await call(env, "GET", "/api/near-radio", undefined, { cookie: me.cookie })).data).toEqual({ on: false });
  });

  it("goes only to a slow station: a fix without a speed counts as slow", async () => {
    const { env } = await player({ on: true });
    await beacon(env, "OE1ABC-7", 20); // 37 km/h: driving past
    expect(await outbox(env)).toEqual([]);
    await beacon(env, "OE1ABC-7", 3); // 5.6 km/h: on foot
    expect(nearMessages(await outbox(env))).toHaveLength(1);
    await addCache(env, "AC-0002", "Second", CACHE.lat + 0.0001);
    await beacon(env, "OE1ABC-7");
    expect(nearMessages(await outbox(env))).toHaveLength(2);
  });

  it("never goes to a station merely heard, nor to an account whose call is not verified", async () => {
    const { env } = await player({ on: true });
    await beacon(env, "OE3OTH-7");
    expect(await outbox(env)).toEqual([]);
    const other = await player({ on: true, verified: false });
    await beacon(other.env);
    expect(await outbox(other.env)).toEqual([]);
  });

  it("skips caches the account owns or has found, and names the nearest with a count of the rest", async () => {
    const { env } = await player({ on: true });
    const t = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type) VALUES (1, 'OE1ABC-9', ?, 'found')",
    )
      .bind(t)
      .run();
    await addCache(env, "AC-0002", "Mine", CACHE.lat, CACHE.lon, "OE1ABC-5");
    await beacon(env);
    expect(await outbox(env)).toEqual([]);
    await addCache(env, "AC-0003", "Far one", CACHE.lat + 0.0005);
    await addCache(env, "AC-0004", "Near one", CACHE.lat - 0.0002);
    await addCache(env, "AC-0005", "Middle one", CACHE.lat);
    await beacon(env);
    const [sent] = nearMessages(await outbox(env));
    expect(sent?.payload).toMatch(/^:OE1ABC-7 :Near AC-0004 Near one \d+m [NESW]+ \+2 more\. Reply FOUND AC-0004\{/);
  });

  it("sends at most four an hour to one person, whatever the SSID", async () => {
    const { env } = await player({ on: true });
    for (let i = 2; i <= 6; i++) await addCache(env, `AC-000${i}`, `Cache ${i}`, CACHE.lat + i * 0.00001);
    for (let i = 0; i < 6; i++) await beacon(env, `OE1ABC-${i + 1}`);
    expect(nearMessages(await outbox(env))).toHaveLength(4);
  });

  it("skips a cache that is not active", async () => {
    const { env } = await player({ on: true });
    await env.DB.prepare("UPDATE caches SET status = 'disabled'").run();
    await beacon(env);
    expect(await outbox(env)).toEqual([]);
  });

  it("goes back through the box's MeshCom node when the station was heard on MeshCom", async () => {
    const { env } = await player({ on: true });
    await call(env, "GET", "/api/box/pi-home/commands?tx=1&rf=0&meshcom=OE8APR-12&kiss=OE8APR-12", undefined, {
      "x-ingest-secret": SECRET,
    });
    await ingest(env, {
      src: "OE1ABC-7",
      payload: `!${AT}>`,
      port: "meshcom",
      heardVia: "rf",
      path: [],
      igateCall: undefined,
      box: "pi-home",
      rxCall: "OE8APR-12",
    });
    expect(await outbox(env)).toEqual([]);
    const cmd = await env.DB.prepare("SELECT kind, payload FROM box_commands").first<{
      kind: string;
      payload: string;
    }>();
    expect(cmd?.kind).toBe("meshcom_msg");
    expect(JSON.parse(cmd!.payload)).toEqual({
      node: "OE8APR-12",
      dst: "OE1ABC-7",
      text: expect.stringMatching(/^Near AC-0001 Landhaus courtyard \d+m N\. Reply FOUND AC-0001$/),
      from: "OE8APR-15",
      msgNo: expect.stringMatching(/^N[0-9A-Z]{4}$/),
    });
  });

  it("NEAR ON over APRS-IS waits for the player's confirmation; NEAR OFF applies at once", async () => {
    const { env } = await player();
    const on = () =>
      env.DB.prepare("SELECT near_radio FROM accounts WHERE callsign = 'OE1ABC'").first<{ near_radio: number }>();
    await ingest(env, { src: "OE1ABC-7", payload: ":OE8APR-15:NEAR ON{3" });
    expect((await on())?.near_radio).toBe(0);
    const row = await env.DB.prepare(
      "SELECT id, account_id, status, body FROM radio_commands WHERE command = 'near'",
    ).first<{
      id: number;
      account_id: string;
      status: string;
      body: string;
    }>();
    expect(row).toMatchObject({ status: "pending", body: "ON" });
    expect((await decideRadioCommand(env, row!.account_id, row!.id, "confirm")).status).toBe(200);
    expect((await on())?.near_radio).toBe(1);
    await ingest(env, { src: "OE1ABC-7", payload: ":OE8APR-15:near off{4" });
    expect((await on())?.near_radio).toBe(0);
  });

  it("NEAR ON heard on the air at an attested site applies at once, and needs a verified call", async () => {
    const onAir = { port: "kiss-tnc", heardVia: "rf", igateCall: SITE, path: ["WIDE1-1"] };
    const { env } = await player();
    await ingest(env, { src: "OE1ABC-7", payload: ":OE8APR-15:NEAR ON{5", ...onAir });
    const flag = async () =>
      (
        await env.DB.prepare("SELECT near_radio FROM accounts WHERE callsign = 'OE1ABC'").first<{
          near_radio: number;
        }>()
      )?.near_radio;
    expect(await flag()).toBe(1);
    const unverified = await player({ verified: false });
    await ingest(unverified.env, { src: "OE1ABC-7", payload: ":OE8APR-15:NEAR ON{5", ...onAir });
    const r = await unverified.env.DB.prepare("SELECT status FROM radio_commands WHERE command = 'near'").first<{
      status: string;
    }>();
    expect(r?.status).toBe("rejected");
  });
});
