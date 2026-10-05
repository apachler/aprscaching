// SPDX-License-Identifier: AGPL-3.0-or-later
// A staged cache is found at its last stage: a find needs that stage unlocked and is verified at its position,
// and replacing the stage list drops the unlocks of every stage from the first one that changed.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, hiderSignup, operatorVerify } from "./helpers/authflow.js";

const at = () => Math.floor(Date.now() / 1000);
const near = (lat: number, lon: number) => ({ lat: lat + 0.0001, lon, accuracyM: 10, ts: at() });
const START = { lat: 47, lon: 15 };
const FINAL = { lat: 47.05, lon: 15.05 };
const STAGES = [
  { stageNo: 0, unlock: "open", ...START },
  { stageNo: 1, unlock: "open", clue: "the bridge", lat: 47.02, lon: 15.02 },
  { stageNo: 2, unlock: "open", clue: "the oak", ...FINAL },
];

async function world() {
  const env = authEnv({ ADMIN_CALLSIGNS: "DL1FND" });
  const owner = await hiderSignup(env, "owner@example.test", "OE8OWN");
  const made = await call(
    env,
    "POST",
    "/api/caches",
    { title: "three bridges", type: "multi", ...START },
    { cookie: owner.cookie },
  );
  const id = made.data.cache.id as number;
  const set = await call(env, "POST", `/api/caches/${id}/stages`, { stages: STAGES }, { cookie: owner.cookie });
  expect(set.status, JSON.stringify(set.data)).toBe(200);
  const finder = await emailSignup(env, "finder@example.test", "DL1FND");
  await operatorVerify(env, "DL1FND");
  const unlock = (n: number) =>
    call(env, "POST", `/api/caches/${id}/stages/${n}/unlock`, {}, { cookie: finder.cookie }).then((r) => r.status);
  const log = (geo: ReturnType<typeof near>) =>
    call(env, "POST", `/api/caches/${id}/logs`, { logType: "found", appGeo: geo }, { cookie: finder.cookie });
  return { env, owner, finder, id, unlock, log };
}

describe("a multi-stage cache", () => {
  it("takes a find only once its last stage is unlocked, and verifies it there", async () => {
    const w = await world();
    const early = await w.log(near(FINAL.lat, FINAL.lon));
    expect(early.status).toBe(409);
    expect(early.data.error).toMatch(/last stage/);

    expect(await w.unlock(1)).toBe(200);
    expect((await w.log(near(FINAL.lat, FINAL.lon))).status).toBe(409);
    expect(await w.unlock(2)).toBe(200);

    // at the published start, far from the last stage, the find is logged but not verified
    const atStart = await w.log(near(START.lat, START.lon));
    expect(atStart.status, JSON.stringify(atStart.data)).toBe(200);
    expect(atStart.data.verified).toBe(false);
  });

  it("verifies a find made at the last stage", async () => {
    const w = await world();
    await w.unlock(1);
    await w.unlock(2);
    const found = await w.log(near(FINAL.lat, FINAL.lon));
    expect(found.status, JSON.stringify(found.data)).toBe(200);
    expect(found.data).toMatchObject({ verified: true, tier: "B" });
  });

  it("drops unlocks from the first stage that changes", async () => {
    const w = await world();
    await w.unlock(1);
    await w.unlock(2);
    const moved = STAGES.map((s) => (s.stageNo === 2 ? { ...s, lat: 47.06 } : s));
    await call(w.env, "POST", `/api/caches/${w.id}/stages`, { stages: moved }, { cookie: w.owner.cookie });
    const view = await call(w.env, "GET", `/api/caches/${w.id}/stages`, undefined, { cookie: w.finder.cookie });
    const open = view.data.stages.map((s: { stageNo: number; unlocked: boolean }) => [s.stageNo, s.unlocked]);
    expect(open).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
  });
});
