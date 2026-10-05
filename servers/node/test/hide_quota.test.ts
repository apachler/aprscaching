// SPDX-License-Identifier: AGPL-3.0-or-later
// An account hides at most HIDE_DAILY_LIMIT new caches in 24 hours. The Hide form reads what is left before the
// player fills it in, and the refusal past the limit says so.
import { describe, it, expect } from "vitest";
import { authEnv, call, hiderSignup } from "./helpers/authflow.js";

describe("the daily hide limit", () => {
  it("counts down what is left, refuses past it, and lifts with 0", async () => {
    const env = authEnv({ HIDE_DAILY_LIMIT: "2" });
    const who = await hiderSignup(env, "quota@example.test", "OE8QTA");
    const quota = async () => (await call(env, "GET", "/api/my/hides", undefined, { cookie: who.cookie })).data;
    const hide = () =>
      call(env, "POST", "/api/caches", { title: "oak", type: "traditional", lat: 47, lon: 15 }, { cookie: who.cookie });

    expect(await quota()).toEqual({ limit: 2, used: 0, remaining: 2 });
    expect((await hide()).status).toBe(201);
    expect(await quota()).toEqual({ limit: 2, used: 1, remaining: 1 });
    expect((await hide()).status).toBe(201);
    expect(await quota()).toEqual({ limit: 2, used: 2, remaining: 0 });
    const refused = await hide();
    expect(refused.status).toBe(429);
    expect(refused.data).toMatchObject({ limit: 2 });

    env.HIDE_DAILY_LIMIT = "0";
    expect(await quota()).toEqual({ limit: null, used: 2, remaining: null });
    expect((await call(env, "GET", "/api/my/hides")).status).toBe(401);
  });
});
