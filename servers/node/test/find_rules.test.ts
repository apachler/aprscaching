// SPDX-License-Identifier: AGPL-3.0-or-later
// The game's rules for logs: a find counts once per person (any SSID of the base call, or any call on the
// account), finds under an SSID count for the person on the leaderboard, an archived or disabled cache takes
// no find or did-not-find, and an owner does not find their own cache.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const at = () => Math.floor(Date.now() / 1000);
const here = () => ({ lat: 47.0001, lon: 15.0001, accuracyM: 10, ts: at() });

async function world(): Promise<{ env: Env; owner: Res; finder: Res; cacheId: number }> {
  // the finder's call is confirmed with the operator secret, the quickest way to a control-verified call here
  const env = authEnv({ ADMIN_CALLSIGNS: "DL1FND" });
  const owner = await emailSignup(env, "owner@example.test", "OE8OWN");
  const created = await call(
    env,
    "POST",
    "/api/caches",
    { title: "oak", type: "traditional", lat: 47, lon: 15 },
    { cookie: owner.cookie },
  );
  expect(created.status).toBe(201);
  const finder = await emailSignup(env, "finder@example.test", "DL1FND");
  return { env, owner, finder, cacheId: created.data.cache.id as number };
}
const log = (w: { env: Env; cacheId: number }, who: Res, body: Record<string, unknown>) =>
  call(w.env, "POST", `/api/caches/${w.cacheId}/logs`, body, { cookie: who.cookie });

describe("a find counts once per person", () => {
  it("another SSID of the same call cannot log the cache again", async () => {
    const w = await world();
    const first = await log(w, w.finder, { logType: "found", loggerCall: "DL1FND-7", appGeo: here() });
    expect(first.status).toBe(200);
    expect(first.data.verified).toBe(true);
    const again = await log(w, w.finder, { logType: "found", loggerCall: "DL1FND-9", appGeo: here() });
    expect(again.status).toBe(409);
    expect(again.data.foundBy).toBe("DL1FND-7");
    expect((await log(w, w.finder, { logType: "found", appGeo: here() })).status).toBe(409);
  });

  it("the same call logging again is answered as the find it already is", async () => {
    const w = await world();
    expect((await log(w, w.finder, { logType: "found", appGeo: here() })).status).toBe(200);
    const replay = await log(w, w.finder, { logType: "found", appGeo: here() });
    expect(replay.status).toBe(200);
    expect(replay.data.duplicate).toBe(true);
  });

  it("finds under an SSID count for the person on the leaderboard, profile and badges", async () => {
    const w = await world();
    await operatorVerify(w.env, "DL1FND");
    expect((await log(w, w.finder, { logType: "found", loggerCall: "DL1FND-7", appGeo: here() })).status).toBe(200);
    const board = await call(w.env, "GET", "/api/leaderboard?metric=finds");
    const row = board.data.leaderboard.find((r: { loggerCall: string }) => r.loggerCall === "DL1FND");
    expect(row?.finds).toBe(1);
    const prof = await call(w.env, "GET", "/api/profile/DL1FND");
    expect(prof.data.finds).toBe(1);
    expect(prof.data.badges.some((b: { badge: string }) => b.badge === "first-find")).toBe(true);
  });
});

describe("archived and disabled caches", () => {
  it("take no find and no did-not-find, but a note", async () => {
    const w = await world();
    for (const status of ["archived", "disabled"]) {
      const upd = await call(w.env, "PATCH", `/api/caches/${w.cacheId}`, { status }, { cookie: w.owner.cookie });
      expect(upd.status).toBe(200);
      const found = await log(w, w.finder, { logType: "found", appGeo: here() });
      expect(found.status).toBe(409);
      expect(found.data.error).toMatch(new RegExp(status));
      expect((await log(w, w.finder, { logType: "dnf" })).status).toBe(409);
      expect((await log(w, w.finder, { logType: "note", comment: "gone?" })).status).toBe(200);
    }
  });
});

describe("an owner does not find their own cache", () => {
  it("under the owner call, an SSID of it, or another call on the owner's account", async () => {
    const w = await world();
    expect((await log(w, w.owner, { logType: "found", appGeo: here() })).status).toBe(409);
    expect((await log(w, w.owner, { logType: "found", loggerCall: "OE8OWN-7", appGeo: here() })).status).toBe(409);
    const sw = await call(w.env, "POST", "/auth/callsign", { callsign: "OE9SEC" }, { cookie: w.owner.cookie });
    expect((await log(w, sw, { logType: "found", appGeo: here() })).status).toBe(409);
    expect((await log(w, sw, { logType: "note", comment: "checked it" })).status).toBe(200);
  });
});

describe("maintenance, enabled and disabled logs", () => {
  it("are the owner's alone", async () => {
    const w = await world();
    for (const logType of ["maintenance", "enabled", "disabled"]) {
      const theirs = await log(w, w.finder, { logType, comment: "fixed the lid" });
      expect(theirs.status, logType).toBe(409);
      expect(theirs.data.error).toMatch(/only the owner/);
    }
    expect((await log(w, w.owner, { logType: "maintenance", comment: "new logbook" })).status).toBe(200);
  });
});
