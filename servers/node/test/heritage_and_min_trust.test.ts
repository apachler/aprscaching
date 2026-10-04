// SPDX-License-Identifier: AGPL-3.0-or-later
// Heritage places come from the sysop's import, never from a player's hide form; a find counts as verified from
// the instance's minimum (MIN_TRUST) up, unless the cache sets its own, which its owner can clear again.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, hiderSignup, operatorVerify } from "./helpers/authflow.js";

const at = () => Math.floor(Date.now() / 1000);
const here = () => ({ lat: 47.0001, lon: 15.0001, accuracyM: 10, ts: at() });
const spot = { lat: 47, lon: 15 };

describe("heritage places", () => {
  it("are refused from a player, on hiding and on editing, and taken from the sysop", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8SYS" });
    const player = await hiderSignup(env, "player@example.test", "OE8PLY");
    const hide = await call(
      env,
      "POST",
      "/api/caches",
      { title: "peak", type: "sota", ...spot },
      { cookie: player.cookie },
    );
    expect(hide.status).toBe(403);
    expect(hide.data.error).toMatch(/heritage/);

    const trad = await call(
      env,
      "POST",
      "/api/caches",
      { title: "peak", type: "traditional", ...spot },
      { cookie: player.cookie },
    );
    expect(trad.status).toBe(201);
    const retype = await call(
      env,
      "PATCH",
      `/api/caches/${trad.data.cache.id}`,
      { type: "pota" },
      { cookie: player.cookie },
    );
    expect(retype.status).toBe(403);

    const sysop = await emailSignup(env, "sysop@example.test", "OE8SYS");
    await operatorVerify(env, "OE8SYS");
    const ok = await call(
      env,
      "POST",
      "/api/caches",
      { title: "summit", type: "sota", ...spot },
      { cookie: sysop.cookie },
    );
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
  });
});

describe("the minimum tier", () => {
  async function world(extra: Record<string, unknown> = {}) {
    const env = authEnv({ ADMIN_CALLSIGNS: "DL1FND", ...extra });
    const owner = await hiderSignup(env, "owner@example.test", "OE8OWN");
    const finder = await emailSignup(env, "finder@example.test", "DL1FND");
    await operatorVerify(env, "DL1FND");
    const hide = async (body: Record<string, unknown> = {}) =>
      (
        await call(
          env,
          "POST",
          "/api/caches",
          { title: "oak", type: "traditional", ...spot, ...body },
          {
            cookie: owner.cookie,
          },
        )
      ).data.cache.id as number;
    const find = async (id: number) =>
      (
        await call(
          env,
          "POST",
          `/api/caches/${id}/logs`,
          { logType: "found", appGeo: here() },
          { cookie: finder.cookie },
        )
      ).data;
    return { env, owner, hide, find };
  }

  it("is Location-verified by default, and Radio-verified on an instance with MIN_TRUST=A", async () => {
    const b = await world();
    expect(await b.find(await b.hide())).toMatchObject({ tier: "B", verified: true });

    const a = await world({ MIN_TRUST: "A" });
    const id = await a.hide();
    expect((await call(a.env, "GET", `/api/caches/${id}`)).data.cache.minTrust).toBe("A");
    expect(await a.find(id)).toMatchObject({ tier: "B", verified: false });
  });

  it("is the cache's own when its hider sets one, and the instance's again once cleared", async () => {
    const w = await world();
    const strict = await w.hide({ minTrust: "A" });
    expect(await w.find(strict)).toMatchObject({ tier: "B", verified: false });

    const relaxed = await w.hide({ minTrust: "A" });
    const clear = await call(w.env, "PATCH", `/api/caches/${relaxed}`, { minTrust: null }, { cookie: w.owner.cookie });
    expect(clear.status, JSON.stringify(clear.data)).toBe(200);
    expect((await call(w.env, "GET", `/api/caches/${relaxed}`)).data.cache.minTrust).toBe("B");
    expect(await w.find(relaxed)).toMatchObject({ tier: "B", verified: true });
  });
});
