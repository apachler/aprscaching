// SPDX-License-Identifier: AGPL-3.0-or-later
// The route of the packet a find was scored against travels with the log, and a station's detail carries the
// route of its latest position: the reader sees why one find is Tier A (an attested site's own receiver heard it)
// and another Tier C (an APRS-IS line, one naming the attested site included).
import { describe, it, expect } from "vitest";
import { scoreFind, commitFind } from "@aprscaching/gateway/caches";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const SITE = "OE8XXX-10";
const AT_SPOT = "!4704.20N/01525.20E>";
const LAT = 47 + 4.2 / 60;
const LON = 15 + 25.2 / 60;
const now = () => Math.floor(Date.now() / 1000);

const room = { fetch: async () => new Response(null, { status: 204 }) };
const world = () => authEnv({ FIRST_PARTY_SITES: SITE, ROOMS: { get: () => room } });

async function cache(env: Env) {
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at)
     VALUES (?, 'OE8OWN', 'Route', 'traditional', ?, ?, 1, 1)`,
  )
    .bind(`AC-RT${Math.random().toString(36).slice(2, 8)}`, LAT, LON)
    .run();
  return (await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(Number(r.meta.last_row_id)).first()) as never;
}

/** One frame through the trusted ingest. */
async function ingest(
  env: Env,
  p: { src: string; path: string[]; heardVia: string; port: string; igateCall?: string },
) {
  const res = await call(
    env,
    "POST",
    "/ingest",
    { packets: [{ dst: "APRS", payload: AT_SPOT, kind: "position", ts: now() - 30, ...p }] },
    INGEST,
  );
  expect(res.status, JSON.stringify(res.data)).toBe(200);
}

async function logOf(env: Env, c: { id: number }) {
  const d = await call(env, "GET", `/api/caches/${c.id}`);
  expect(d.status).toBe(200);
  return d.data.cache.logs[0];
}

describe("the route kept with a find", () => {
  it("shows the attested site's own receiver behind a Tier-A find", async () => {
    const env = world();
    const c = await cache(env);
    await ingest(env, {
      src: "OE8LOG-9",
      path: ["OE8DIG-1*", "WIDE2-1"],
      heardVia: "rf",
      port: "kiss-tnc",
      igateCall: SITE,
    });
    const score = await scoreFind(env, c, "OE8LOG-9", now());
    expect(score.result.tier).toBe("A");
    await commitFind(env, c, "OE8LOG-9", now(), null, score);
    expect((await logOf(env, c)).route).toMatchObject({
      src: "OE8LOG-9",
      path: "OE8DIG-1*,WIDE2-1",
      heardVia: "rf",
      transport: "tnc",
      site: SITE,
      attested: true,
      siteAttested: true,
    });
  });

  it("shows an APRS-IS line naming the attested site as unattested, and the find stays Tier C", async () => {
    const env = world();
    const c = await cache(env);
    await ingest(env, {
      src: "OE8LOG-9",
      path: ["WIDE1-1", "qAR", SITE],
      heardVia: "rf",
      port: "aprs-is",
      igateCall: SITE,
    });
    const score = await scoreFind(env, c, "OE8LOG-9", now());
    expect(score.result.tier).toBe("C");
    await commitFind(env, c, "OE8LOG-9", now(), null, score);
    expect((await logOf(env, c)).route).toMatchObject({
      path: "WIDE1-1,qAR," + SITE,
      transport: "aprs-is",
      site: SITE,
      attested: false,
      siteAttested: true,
    });
  });

  it("keeps no route when no packet placed the finder (Tier B)", async () => {
    const env = world();
    const c = await cache(env);
    const score = await scoreFind(env, c, "OE8LOG-9", now(), { lat: LAT, lon: LON, accuracyM: 5, ts: now() });
    expect(score.result.tier).toBe("B");
    await commitFind(env, c, "OE8LOG-9", now(), null, score);
    expect((await logOf(env, c)).route).toBeUndefined();
  });
});

describe("the route on station detail", () => {
  it("is the route of the station's latest position", async () => {
    const env = world();
    await ingest(env, { src: "OE8MOB-9", path: ["TCPIP*", "qAC", "T2AUSTRIA"], heardVia: "aprs_is", port: "aprs-is" });
    const st = await call(env, "GET", "/api/stations/OE8MOB-9");
    expect(st.status).toBe(200);
    expect(st.data.station.lastRoute).toMatchObject({
      src: "OE8MOB-9",
      path: "TCPIP*,qAC,T2AUSTRIA",
      heardVia: "aprs_is",
      transport: "aprs-is",
      attested: false,
    });
  });
});
