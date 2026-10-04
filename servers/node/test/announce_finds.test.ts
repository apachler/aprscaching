// SPDX-License-Identifier: AGPL-3.0-or-later
// Announcing finds on APRS-IS is the account's own opt-in: off by default, set from Settings, and followed by a
// find from any SSID of a verified call the account holds.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, hiderSignup, operatorVerify } from "./helpers/authflow.js";

const at = () => Math.floor(Date.now() / 1000);
const here = () => ({ lat: 47.0001, lon: 15.0001, accuracyM: 10, ts: at() });

describe("announce finds", () => {
  it("is off by default, needs a session, and follows the switch", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8ANN" });
    const owner = await hiderSignup(env, "owner@example.test", "OE8OWN");
    const cache = (title: string) =>
      call(env, "POST", "/api/caches", { title, type: "traditional", lat: 47, lon: 15 }, { cookie: owner.cookie }).then(
        (r) => r.data.cache.id as number,
      );
    const me = await emailSignup(env, "ann@example.test", "OE8ANN");
    await operatorVerify(env, "OE8ANN");
    const find = async (id: number) =>
      (
        await call(
          env,
          "POST",
          `/api/caches/${id}/logs`,
          { logType: "found", loggerCall: "OE8ANN-7", appGeo: here() },
          { cookie: me.cookie },
        )
      ).data;

    expect((await call(env, "GET", "/api/announce")).status).toBe(401);
    expect((await call(env, "GET", "/api/announce", undefined, { cookie: me.cookie })).data).toEqual({ on: false });
    expect((await find(await cache("first"))).announced).toBeFalsy();

    expect((await call(env, "POST", "/api/announce", { on: "yes" }, { cookie: me.cookie })).status).toBe(400);
    expect((await call(env, "POST", "/api/announce", { on: true }, { cookie: me.cookie })).data).toEqual({ on: true });
    expect((await find(await cache("second"))).announced).toBe(true);
    const out = await env.DB.prepare("SELECT src_call, payload FROM aprs_outbox").all<{
      src_call: string;
      payload: string;
    }>();
    expect(out.results).toEqual([{ src_call: "OE8ANN-7", payload: ">Found AC-0002 (second) via gw.test" }]);

    await call(env, "POST", "/api/announce", { on: false }, { cookie: me.cookie });
    expect((await find(await cache("third"))).announced).toBeFalsy();
  });
});
