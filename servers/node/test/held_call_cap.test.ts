// SPDX-License-Identifier: AGPL-3.0-or-later
// An unverified held call answers every other sign-up for it with "prove you control it", so an account that
// could hold calls without bound could lock a whole licence list out of sign-up. An account holds a few calls
// unverified at a time; proving control of one makes room for another. Taking on a call is throttled too.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, markCallVerified } from "./helpers/authflow.js";

const add = (env: Env, cookie: string, callsign: string, ip?: string) =>
  call(env, "POST", "/auth/callsigns", { callsign }, { cookie }, ip);

describe("the calls an account holds unverified", () => {
  it("are capped at three, and a verified one makes room for another", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "op@example.test", "OE8AAA");
    expect((await add(env, me.cookie, "OE8AAB")).status).toBe(200);
    expect((await add(env, me.cookie, "OE8AAC")).status).toBe(200);
    const over = await add(env, me.cookie, "OE8AAD");
    expect(over.status).toBe(409);
    expect(over.data.reason).toBe("too_many_unverified");
    expect(await env.DB.prepare("SELECT 1 FROM account_callsigns WHERE callsign = 'OE8AAD'").first()).toBeNull();
    await markCallVerified(env, "OE8AAA");
    expect((await add(env, me.cookie, "OE8AAD")).status).toBe(200);
  });

  it("count a new call taken on by switching to it", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "op@example.test", "OE8AAA");
    expect((await add(env, me.cookie, "OE8AAB")).status).toBe(200);
    expect((await add(env, me.cookie, "OE8AAC")).status).toBe(200);
    const sw = await call(env, "POST", "/auth/callsign", { callsign: "OE8AAD" }, { cookie: me.cookie });
    expect(sw.status).toBe(409);
    expect(sw.data.reason).toBe("too_many_unverified");
    // switching among the calls it already holds stays open
    expect((await call(env, "POST", "/auth/callsign", { callsign: "OE8AAB" }, { cookie: me.cookie })).status).toBe(200);
  });

  it("are taken on at a throttled rate per account", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "op@example.test", "OE8AAA");
    await markCallVerified(env, "OE8AAA");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const cs = `OE8B${String.fromCharCode(65 + i)}A`;
      const r = await add(env, me.cookie, cs, `198.51.100.${i + 1}`);
      statuses.push(r.status);
      if (r.status === 200) await markCallVerified(env, cs);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
