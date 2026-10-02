// SPDX-License-Identifier: AGPL-3.0-or-later
// A living cache follows one of its hider's own stations (Settings → My stations), never another
// operator's beacon: on hiding, on editing, and through "become a cache".
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";

const living = (stationCall?: string) => ({
  title: "rover",
  type: "aprs_living",
  lat: 47,
  lon: 15,
  ...(stationCall ? { stationCall } : {}),
});

describe("a living cache follows its hider's own station", () => {
  it("is hidden on a station in My stations, and refused on any other", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8ROV" });
    const me = await emailSignup(env, "rover@example.test", "OE8ROV");
    await operatorVerify(env, "OE8ROV"); // only a verified call's stations are listed
    const add = await call(
      env,
      "POST",
      "/api/my/stations",
      { callsign: "OE8ROV-9", lat: 47, lon: 15 },
      { cookie: me.cookie },
    );
    expect(add.status, JSON.stringify(add.data)).toBe(201);
    const ok = await call(env, "POST", "/api/caches", living("OE8ROV-9"), { cookie: me.cookie });
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
    const foreign = await call(env, "POST", "/api/caches", living("DL1XYZ-9"), { cookie: me.cookie });
    expect(foreign.status).toBe(403);
    expect(foreign.data.error).toMatch(/not one of your stations/);
    expect((await call(env, "POST", "/api/caches", living(), { cookie: me.cookie })).status).toBe(403);
  });

  it("an edit cannot point a living cache at another operator's station", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8ROV" });
    const me = await emailSignup(env, "rover@example.test", "OE8ROV");
    await operatorVerify(env, "OE8ROV"); // only a verified call's stations are listed
    await call(env, "POST", "/api/my/stations", { callsign: "OE8ROV-9", lat: 47, lon: 15 }, { cookie: me.cookie });
    const c = await call(env, "POST", "/api/caches", living("OE8ROV-9"), { cookie: me.cookie });
    const id = c.data.cache.id;
    const edit = await call(env, "PATCH", `/api/caches/${id}`, { stationCall: "DL1XYZ-9" }, { cookie: me.cookie });
    expect(edit.status).toBe(403);
    const toLiving = await call(
      env,
      "POST",
      "/api/caches",
      { title: "oak", type: "traditional", lat: 47, lon: 15 },
      { cookie: me.cookie },
    );
    const turn = await call(
      env,
      "PATCH",
      `/api/caches/${toLiving.data.cache.id}`,
      { type: "aprs_living", stationCall: "DL1XYZ-9" },
      { cookie: me.cookie },
    );
    expect(turn.status).toBe(403);
  });

  it("becoming a cache adds the beacon's station to My stations, unless another operator has it", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8ROV" });
    const me = await emailSignup(env, "rover@example.test", "OE8ROV");
    await operatorVerify(env, "OE8ROV"); // only a verified call's stations are listed
    await call(env, "POST", "/auth/profile", { homeGrid: "JN77" }, { cookie: me.cookie });
    const become = await call(env, "POST", "/api/me/cache", {}, { cookie: me.cookie });
    expect(become.status).toBe(201);
    const mine = await call(env, "GET", "/api/my/stations", undefined, { cookie: me.cookie });
    expect(mine.data.stations.map((s: { callsign: string }) => s.callsign)).toContain("OE8ROV");

    // a club station the sysop listed for another member
    await emailSignup(env, "other@example.test", "OE8OTH");
    const listed = await call(
      env,
      "POST",
      "/api/admin/stations",
      { owner: "OE8OTH", callsign: "OE8SQT", lat: 47, lon: 15 },
      { cookie: me.cookie },
    );
    expect(listed.status, JSON.stringify(listed.data)).toBe(201);
    const squat = await emailSignup(env, "squat@example.test", "OE8SQT");
    await call(env, "POST", "/auth/profile", { homeGrid: "JN77" }, { cookie: squat.cookie });
    expect((await call(env, "POST", "/api/me/cache", {}, { cookie: squat.cookie })).status).toBe(409);
  });
});
