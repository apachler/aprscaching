// SPDX-License-Identifier: AGPL-3.0-or-later
// The sysop role follows a control-verified licence, not a string: signing up as a call listed in
// ADMIN_CALLSIGNS grants nothing until the account holding that call has proven control of it.
import { describe, it, expect } from "vitest";
import { authEnv, call, controlVerify, emailSignup } from "./helpers/authflow.js";

const RULE = { partner: "rf-oe", route: "OE", transport: "rf-fbb" };

describe("sysop requires a held, control-verified ADMIN_CALLSIGNS call", () => {
  it("an unverified sign-up as the admin call is not a sysop", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const s = await emailSignup(env, "op@example.test", "OE8APR");
    expect(s.status).toBe(200);
    const who = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: s.cookie });
    expect(who.data.sysop).toBe(false);
    const add = await call(env, "POST", "/api/bbs/forward", RULE, { cookie: s.cookie });
    expect(add.status).toBe(403);
  });

  it("the same account is a sysop once it control-verifies the call", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const s = await emailSignup(env, "op@example.test", "OE8APR");
    await controlVerify(env, "OE8APR");
    const who = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: s.cookie });
    expect(who.data.sysop).toBe(true);
    const add = await call(env, "POST", "/api/bbs/forward", RULE, { cookie: s.cookie });
    expect(add.status).toBe(201);
  });

  it("a verified call held by a different account does not make a session on its string a sysop", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    await emailSignup(env, "op@example.test", "OE8APR");
    await controlVerify(env, "OE8APR");
    // a stray account row naming the admin call exactly, owned by someone else
    await env.DB.prepare("UPDATE accounts SET account_id='acct-evil' WHERE callsign='OE8APR'").run();
    await env.DB.prepare(
      "INSERT INTO accounts (callsign, account_id, email, verified, created_at) VALUES ('OE8APR-1','acct-evil2','evil@example.test',0,1)",
    ).run();
    const login = await call(env, "POST", "/auth/email/start", { email: "op@example.test" });
    const ver = await call(env, "POST", "/auth/email/verify", { token: login.data.devToken });
    const who = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: ver.cookie });
    expect(who.data.sysop).toBe(false);
  });
});
