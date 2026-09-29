// SPDX-License-Identifier: AGPL-3.0-or-later
// A base call belongs to exactly one account. Signing up as an SSID of someone else's base call
// (OE1VIC-9 while OE1VIC is held) must be refused on every path, and a session must only ever resolve
// to an account that actually holds its call — otherwise the SSID session lands on the holder's account.
import { describe, it, expect } from "vitest";
import {
  authEnv,
  call,
  emailSignup,
  newAuthenticator,
  passkeyRegister,
  passkeyRegisterFinish,
} from "./helpers/authflow.js";

async function victim() {
  const env = authEnv();
  const v = await emailSignup(env, "victim@example.test", "OE1VIC");
  expect(v.status).toBe(200);
  return { env, victimCookie: v.cookie };
}

describe("an SSID of a held base call cannot open a second account", () => {
  it("email sign-up as OE1VIC-9 is refused at start", async () => {
    const { env } = await victim();
    const start = await call(env, "POST", "/auth/email/start", { email: "evil@example.test", callsign: "OE1VIC-9" });
    expect(start.status).toBe(409);
  });

  it("email sign-up is refused at verify when the base call was claimed after start", async () => {
    const env = authEnv();
    const start = await call(env, "POST", "/auth/email/start", { email: "evil@example.test", callsign: "OE1VIC-9" });
    expect(start.status).toBe(200);
    expect((await emailSignup(env, "victim@example.test", "OE1VIC")).status).toBe(200);
    const ver = await call(env, "POST", "/auth/email/verify", { token: start.data.devToken });
    expect(ver.status).toBe(409);
    expect(ver.cookie).toBe("");
  });

  it("passkey registration as OE1VIC-9 is refused at begin", async () => {
    const { env } = await victim();
    const r = await passkeyRegister(env, "OE1VIC-9", await newAuthenticator());
    expect(r.status).toBe(409);
  });

  it("passkey registration is refused at finish when the base call was claimed during the ceremony", async () => {
    const env = authEnv();
    const begin = await call(env, "POST", "/auth/passkey/register/begin", { callsign: "OE1VIC-9" });
    expect(begin.status).toBe(200);
    expect((await emailSignup(env, "victim@example.test", "OE1VIC")).status).toBe(200);
    const fin = await passkeyRegisterFinish(env, "OE1VIC-9", await newAuthenticator(), begin.data.challenge);
    expect(fin.status).toBe(409);
    const acct = await env.DB.prepare("SELECT 1 FROM accounts WHERE callsign='OE1VIC-9'").first();
    expect(acct).toBeNull();
  });

  it("a stray SSID account never resolves to the base call holder's account", async () => {
    const { env } = await victim();
    // an account row naming an SSID of a base call that another account holds
    await env.DB.prepare(
      "INSERT INTO accounts (callsign, account_id, email, created_at) VALUES ('OE1VIC-9','acct-evil','evil@example.test',1)",
    ).run();
    const login = await call(env, "POST", "/auth/email/start", { email: "evil@example.test" });
    const ver = await call(env, "POST", "/auth/email/verify", { token: login.data.devToken });
    expect(ver.status).toBe(200);
    // the stray session must not read the victim's held calls
    const mine = await call(env, "GET", "/auth/callsigns", undefined, { cookie: ver.cookie });
    expect(mine.status).toBe(401);
  });

  it("a device key may only be registered for a base call the session's account holds", async () => {
    const { env } = await victim();
    await env.DB.prepare(
      "INSERT INTO accounts (callsign, account_id, email, created_at) VALUES ('OE1VIC-9','acct-evil','evil@example.test',1)",
    ).run();
    const login = await call(env, "POST", "/auth/email/start", { email: "evil@example.test" });
    const ver = await call(env, "POST", "/auth/email/verify", { token: login.data.devToken });
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const reg = await call(
      env,
      "POST",
      "/keys/register",
      { callsign: "OE1VIC", publicKey: key },
      { cookie: ver.cookie },
    );
    expect([401, 403]).toContain(reg.status);
    const bound = await env.DB.prepare("SELECT 1 FROM callsign_keys WHERE callsign='OE1VIC'").first();
    expect(bound).toBeNull();
  });

  it("the holder still signs in and registers a key for an SSID of their own call", async () => {
    const { env, victimCookie } = await victim();
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const reg = await call(
      env,
      "POST",
      "/keys/register",
      { callsign: "OE1VIC-7", publicKey: key },
      { cookie: victimCookie },
    );
    expect(reg.status).toBe(200);
    const mine = await call(env, "GET", "/auth/callsigns", undefined, { cookie: victimCookie });
    expect(mine.data.callsigns.map((c: { callsign: string }) => c.callsign)).toEqual(["OE1VIC"]);
  });
});
