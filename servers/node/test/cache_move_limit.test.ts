// SPDX-License-Identifier: AGPL-3.0-or-later
// A found cache stays near where it was found: before its first find the owner moves it freely; from then on each
// of its coordinates (its own and every stage's) moves at most CACHE_MOVE_LIMIT_M from where it stood at the first
// find, a found stage stays part of the cache, a living cache is exempt, and the sysop corrects any coordinate.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, hiderSignup, operatorVerify } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const at = () => Math.floor(Date.now() / 1000);
const HOME = { lat: 47, lon: 15 };
/** About 55 m north of HOME, inside the default 100 m. */
const NEAR = { lat: 47.0005, lon: 15 };
/** About 220 m north of HOME. */
const FAR = { lat: 47.002, lon: 15 };

async function world(extra: Record<string, unknown> = {}, type = "traditional") {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8SYS,DL1FND", ...extra });
  const owner = await hiderSignup(env, "owner@example.test", "OE8OWN");
  const made = await call(env, "POST", "/api/caches", { title: "the oak", type, ...HOME }, { cookie: owner.cookie });
  expect(made.status, JSON.stringify(made.data)).toBe(201);
  const id = made.data.cache.id as number;
  const finder = await emailSignup(env, "finder@example.test", "DL1FND");
  await operatorVerify(env, "DL1FND");
  const find = (p: { lat: number; lon: number }) =>
    call(
      env,
      "POST",
      `/api/caches/${id}/logs`,
      { logType: "found", appGeo: { ...p, accuracyM: 10, ts: at() } },
      { cookie: finder.cookie },
    );
  const move = (p: { lat: number; lon: number }) =>
    call(env, "PATCH", `/api/caches/${id}`, p, { cookie: owner.cookie });
  const detail = () => call(env, "GET", `/api/caches/${id}`, undefined, { cookie: owner.cookie });
  return { env, owner, finder, id, find, move, detail };
}

async function sysop(env: Env) {
  const s = await emailSignup(env, "sysop@example.test", "OE8SYS");
  await operatorVerify(env, "OE8SYS");
  return s.cookie;
}

describe("moving a cache", () => {
  it("is free before the first find", async () => {
    const w = await world();
    const moved = await w.move(FAR);
    expect(moved.status, JSON.stringify(moved.data)).toBe(200);
    expect((await w.detail()).data.cache.own.move).toEqual({ limitM: 100, pinned: null, stagePins: [] });
  });

  it("after a find, stays within the limit of where it was found", async () => {
    const w = await world();
    expect((await w.find(HOME)).status).toBe(200);
    expect((await w.detail()).data.cache.own.move.pinned).toEqual(HOME);

    expect((await w.move(NEAR)).status).toBe(200);
    // measured from where it was found, not from its last place: two short moves do not add up
    const far = await w.move(FAR);
    expect(far.status).toBe(409);
    expect(far.data.error).toMatch(/at most 100 m.*Archive the cache and hide a new one/);
    expect((await w.detail()).data.cache).toMatchObject(NEAR);
  });

  it("takes its limit from CACHE_MOVE_LIMIT_M, where 0 keeps a found cache in place", async () => {
    const wide = await world({ CACHE_MOVE_LIMIT_M: "500" });
    await wide.find(HOME);
    expect((await wide.move(FAR)).status).toBe(200);

    const fixed = await world({ CACHE_MOVE_LIMIT_M: "0" });
    await fixed.find(HOME);
    const r = await fixed.move(NEAR);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/stays where it was found/);
  });

  it("keeps each found stage near its place and part of the cache, wherever it is renumbered to", async () => {
    const w = await world({}, "multi");
    const stages = [
      { stageNo: 0, unlock: "open", ...HOME },
      { stageNo: 1, unlock: "open", lat: 47.01, lon: 15.01 },
    ];
    const set = (body: unknown[]) =>
      call(w.env, "POST", `/api/caches/${w.id}/stages`, { stages: body }, { cookie: w.owner.cookie });
    expect((await set(stages)).status).toBe(200);
    // a free move before any find
    expect((await set([stages[0], { ...stages[1], lat: 47.02 }])).status).toBe(200);
    await call(w.env, "POST", `/api/caches/${w.id}/stages/1/unlock`, {}, { cookie: w.finder.cookie });
    const found = await w.find({ lat: 47.02, lon: 15.01 });
    expect(found.status, JSON.stringify(found.data)).toBe(200);
    expect((await w.detail()).data.cache.own.move.stagePins).toEqual([
      { stageNo: 0, ...HOME },
      { stageNo: 1, lat: 47.02, lon: 15.01 },
    ]);

    const tooFar = await set([stages[0], { ...stages[1], lat: 47.03 }]);
    expect(tooFar.status).toBe(409);
    expect(tooFar.data.error).toMatch(/^Stage 1 has been found/);
    const dropped = await set([stages[0]]);
    expect(dropped.status).toBe(409);
    expect(dropped.data.error).toMatch(/stays part of the cache/);

    // a new stage goes in freely; the found one moves to number 2 and keeps its pin
    const renumbered = await set([
      stages[0],
      { stageNo: 1, unlock: "open", lat: 47.1, lon: 15.1 },
      { stageNo: 2, prevStageNo: 1, unlock: "open", lat: 47.0201, lon: 15.01 },
    ]);
    expect(renumbered.status, JSON.stringify(renumbered.data)).toBe(200);
    expect((await w.detail()).data.cache.own.move.stagePins).toEqual([
      { stageNo: 0, ...HOME },
      { stageNo: 2, lat: 47.02, lon: 15.01 },
    ]);
    // claiming the found stage's old number for a far place does not carry its pin away
    const disguised = await set([
      stages[0],
      { stageNo: 1, unlock: "open", lat: 47.1, lon: 15.1 },
      { stageNo: 2, unlock: "open", lat: 47.5, lon: 15.5 },
    ]);
    expect(disguised.status).toBe(409);
  });

  it("does not hold a living cache, which follows its station", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8OWN" });
    const owner = await hiderSignup(env, "owner@example.test", "OE8OWN");
    await operatorVerify(env, "OE8OWN"); // only a verified call's stations are listed
    const st = await call(env, "POST", "/api/my/stations", { callsign: "OE8OWN-9", ...HOME }, { cookie: owner.cookie });
    expect(st.status, JSON.stringify(st.data)).toBe(201);
    const made = await call(
      env,
      "POST",
      "/api/caches",
      { title: "catch me", type: "aprs_living", stationCall: "OE8OWN-9", ...HOME },
      { cookie: owner.cookie },
    );
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const id = made.data.cache.id as number;
    await env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method) VALUES (?, 'DL1FND', ?, 'found', 0, 'C', 'aprs_is')",
    )
      .bind(id, at())
      .run();
    expect((await call(env, "PATCH", `/api/caches/${id}`, FAR, { cookie: owner.cookie })).status).toBe(200);
  });

  it("pins a cache found by another path the first time it is moved", async () => {
    const w = await world();
    await w.env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method) VALUES (?, 'DL1FND', ?, 'found', 0, 'C', 'aprs_is')",
    )
      .bind(w.id, at())
      .run();
    expect((await w.move(FAR)).status).toBe(409);
  });

  it("lets the sysop correct a found cache beyond the limit, and pins it at the correction", async () => {
    const w = await world();
    await w.find(HOME);
    const place = (body: unknown, cookie: string) =>
      call(w.env, "POST", `/api/admin/caches/${w.id}/place`, body, { cookie });
    expect((await place(FAR, w.owner.cookie)).status).toBe(403);
    const fixed = await place(FAR, await sysop(w.env));
    expect(fixed.status, JSON.stringify(fixed.data)).toBe(200);
    const d = (await w.detail()).data.cache;
    expect(d).toMatchObject(FAR);
    expect(d.own.move.pinned).toEqual(FAR);
    // the owner's limit now counts from the corrected place
    expect((await w.move({ lat: FAR.lat + 0.0005, lon: FAR.lon })).status).toBe(200);
  });
});
