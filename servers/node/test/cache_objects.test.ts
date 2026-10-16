// SPDX-License-Identifier: AGPL-3.0-or-later
// Caches as APRS objects on air, end to end over SQLite: the sysop's settings are stored; a run queues an
// `object` box command from the service call for the transmitting box, with only the active, public, native
// caches near the position the box reports; an archived cache goes out killed; a non-sysop cannot turn it on; and
// a cache object heard back is never stored as its sender's position.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";
import { loadSiteSettings } from "@aprscaching/gateway/siteconfig";
import { runCacheObjects } from "@aprscaching/gateway/cacheobjects";

const SECRET = { "x-ingest-secret": "test-ingest-secret" };
/** Where the transmitting box stands, as it reports with its poll. */
const BOX = { lat: 46.6, lon: 14.3 };

interface World {
  env: Env;
  sysop: Res;
}

async function world(): Promise<World> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", FIRST_PARTY_SITES: "OE8XXX" });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", "198.51.100.7");
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}

const put = (w: World, key: string, value: string, cookie = w.sysop.cookie) =>
  call(w.env, "PUT", `/api/admin/settings/${key}`, { value }, { cookie });

async function addCache(env: Env, code: string, at: { lat: number; lon: number }, over: Record<string, string> = {}) {
  const c = { type: "traditional", status: "active", fed_scope: "public", source: "native", ...over };
  await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, status, fed_scope, source, lat, lon, created_at, updated_at)
     VALUES (?, 'OE8APR', ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  )
    .bind(code, `Cache ${code}`, c.type, c.status, c.fed_scope, c.source, at.lat, at.lon)
    .run();
}

/** The box polls, reporting that it transmits on RF and where it stands; returns what it leased. */
async function poll(env: Env, box = "home") {
  const r = await call(
    env,
    "GET",
    `/api/box/${box}/commands?tx=1&rf=1&lat=${BOX.lat}&lon=${BOX.lon}`,
    undefined,
    SECRET,
  );
  expect(r.status).toBe(200);
  return r.data.commands as { kind: string; callsign: string; payload: Record<string, unknown> }[];
}

async function turnOn(w: World) {
  for (const [k, v] of [
    ["CACHE_OBJECTS", "1"],
    ["CACHE_OBJECTS_BOX", "home"],
    ["CACHE_OBJECTS_PATH", "WIDE1-1"],
  ] as const)
    expect((await put(w, k, v)).status).toBe(200);
  await loadSiteSettings(w.env, true);
}

describe("cache objects on air", () => {
  it("stores the sysop's settings and refuses them to a player", async () => {
    const w = await world();
    const player = await emailSignup(w.env, "p@example.test", "OE6ABC", "198.51.100.8");
    expect((await put(w, "CACHE_OBJECTS", "1", player.cookie)).status).toBe(403);
    expect((await put(w, "CACHE_OBJECTS_PATH", "WIDE2-2")).status).toBe(400);
    expect((await put(w, "CACHE_OBJECTS_RADIUS_KM", "100")).status).toBe(400);
    await turnOn(w);
    const rows = (
      await w.env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'CACHE_OBJECTS%' ORDER BY key").all<{
        key: string;
        value: string;
      }>()
    ).results;
    expect(rows).toEqual([
      { key: "CACHE_OBJECTS", value: "1" },
      { key: "CACHE_OBJECTS_BOX", value: "home" },
      { key: "CACHE_OBJECTS_PATH", value: "WIDE1-1" },
    ]);
    const list = await call(w.env, "GET", "/api/admin/settings", undefined, { cookie: w.sysop.cookie });
    const radius = list.data.settings.find((s: { key: string }) => s.key === "CACHE_OBJECTS_RADIUS_KM");
    expect(radius).toMatchObject({ group: "radio", value: "20", gate: "CACHE_OBJECTS" });
  });

  it("queues nothing while it is off, and nothing before the box reports it can transmit", async () => {
    const w = await world();
    await addCache(w.env, "AC-1", { lat: 46.62, lon: 14.31 });
    await poll(w.env);
    expect(await runCacheObjects(w.env)).toEqual({ skipped: "off" });
    await turnOn(w);
    await call(w.env, "GET", "/api/box/home/commands?tx=0&rf=1", undefined, SECRET);
    expect(await runCacheObjects(w.env)).toMatchObject({ skipped: expect.stringMatching(/cannot transmit/) });
    const n = await w.env.DB.prepare("SELECT COUNT(*) AS n FROM box_commands").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("queues the nearby public caches from the service call, then kills an archived one", async () => {
    const w = await world();
    await addCache(w.env, "AC-1", { lat: 46.62, lon: 14.31 });
    await addCache(w.env, "AC-FAR", { lat: 47.6, lon: 14.3 }); // about 110 km away
    await addCache(w.env, "AC-OLD", { lat: 46.61, lon: 14.3 }, { status: "archived" });
    await addCache(w.env, "AC-OFF", { lat: 46.61, lon: 14.3 }, { status: "disabled" });
    await addCache(w.env, "AC-UNL", { lat: 46.61, lon: 14.3 }, { fed_scope: "unlisted" });
    await addCache(w.env, "AC-LIV", { lat: 46.61, lon: 14.3 }, { type: "aprs_living" });
    await addCache(w.env, "OC1234", { lat: 46.61, lon: 14.3 }, { source: "opencaching" });
    await turnOn(w);
    await poll(w.env);

    const t0 = Math.floor(Date.now() / 1000);
    expect(await runCacheObjects(w.env, t0)).toEqual({ queued: 1 });
    const leased = await poll(w.env);
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({
      kind: "object",
      callsign: "OE8APR-15",
      payload: { name: "AC-1", lat: 46.62, lon: 14.31, comment: "Cache AC-1", alive: true, path: ["WIDE1-1"] },
    });
    // not due again within five minutes
    expect(await runCacheObjects(w.env, t0 + 60)).toEqual({ queued: 0 });

    await w.env.DB.prepare("UPDATE caches SET status = 'archived' WHERE code = 'AC-1'").run();
    expect(await runCacheObjects(w.env, t0 + 120)).toEqual({ queued: 1 });
    const killed = await poll(w.env);
    expect(killed[0]).toMatchObject({ kind: "object", payload: { name: "AC-1", alive: false } });
  });

  it("holds the objects of a service call that is not control-verified", async () => {
    const w = await world();
    w.env = { ...w.env, SERVICE_CALL: "OE6ABC-15" } as Env;
    await addCache(w.env, "AC-1", { lat: 46.62, lon: 14.31 });
    await turnOn(w);
    await poll(w.env);
    expect(await runCacheObjects(w.env)).toEqual({ skipped: "OE6ABC-15 is not control-verified" });
  });

  it("never stores a cache object heard back as its sender's position", async () => {
    const w = await world();
    const ts = Math.floor(Date.now() / 1000);
    const heard = (src: string, payload: string) => ({
      src,
      dst: "APZACG",
      path: ["WIDE1-1", "qAR", "OE8XXX"],
      payload,
      kind: "object",
      heardVia: "rf",
      igateCall: "OE8XXX",
      port: "kiss-tnc",
      ts,
    });
    const r = await call(
      w.env,
      "POST",
      "/ingest",
      {
        packets: [
          heard("OE8APR-15", ";AC-1     *150705z4637.20N\\01418.60EiCache AC-1"),
          heard("OE8APR-7", ";AC-1     _150705z4637.20N\\01418.60Ei"),
          // a station's own position report in the same batch is stored as ever
          { ...heard("OE6ABC-9", "!4637.20N/01418.60E>"), kind: "position" },
        ],
      },
      SECRET,
    );
    expect(r.status).toBe(200);
    const calls = async (table: string) =>
      (await w.env.DB.prepare(`SELECT callsign FROM ${table}`).all<{ callsign: string }>()).results.map(
        (x) => x.callsign,
      );
    expect(await calls("positions")).toEqual(["OE6ABC-9"]);
    expect(await calls("stations")).toEqual(["OE6ABC-9"]);
  });
});
