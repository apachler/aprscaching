// SPDX-License-Identifier: AGPL-3.0-or-later
// The edit form's starting point: the cache detail carries the owner's own settings, and the stage list shows the
// owner every stage with its position and tag code; anyone else sees neither.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

describe("the owner's view of a cache", () => {
  it("carries the settings to edit, and every stage as set", async () => {
    const env = authEnv();
    const owner = await emailSignup(env, "owner@example.test", "OE8OWN");
    const other = await emailSignup(env, "other@example.test", "OE8OTH");
    const made = await call(
      env,
      "POST",
      "/api/caches",
      { title: "bridges", type: "multi", lat: 47, lon: 15, minTrust: "A" },
      { cookie: owner.cookie },
    );
    const id = made.data.cache.id as number;
    await call(
      env,
      "POST",
      `/api/caches/${id}/stages`,
      {
        stages: [
          { stageNo: 0, unlock: "open", lat: 47, lon: 15 },
          { stageNo: 1, unlock: "nfc", lat: 47.01, lon: 15.01, secret: "TAG-SECRET-1" },
        ],
      },
      { cookie: owner.cookie },
    );

    const mine = (await call(env, "GET", `/api/caches/${id}`, undefined, { cookie: owner.cookie })).data.cache;
    expect(mine.own).toEqual({ minTrust: "A", rendezvous: false });
    const theirs = (await call(env, "GET", `/api/caches/${id}`, undefined, { cookie: other.cookie })).data.cache;
    expect(theirs.own).toBeUndefined();

    const stages = (cookie: string) =>
      call(env, "GET", `/api/caches/${id}/stages`, undefined, { cookie }).then((r) => r.data.stages[1]);
    expect(await stages(owner.cookie)).toMatchObject({ lat: 47.01, lon: 15.01, secret: "TAG-SECRET-1" });
    const locked = await stages(other.cookie);
    expect(locked).toMatchObject({ lat: null, lon: null, unlocked: false });
    expect(locked.secret).toBeUndefined();

    // clearing the cache's own minimum returns it to the instance's
    await call(env, "PATCH", `/api/caches/${id}`, { minTrust: null, status: "disabled" }, { cookie: owner.cookie });
    const after = (await call(env, "GET", `/api/caches/${id}`, undefined, { cookie: owner.cookie })).data.cache;
    expect(after).toMatchObject({ status: "disabled", own: { minTrust: null } });
  });
});
