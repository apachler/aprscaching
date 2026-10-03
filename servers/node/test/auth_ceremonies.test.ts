// SPDX-License-Identifier: AGPL-3.0-or-later
// Passkey ceremonies follow the account, not a call string: a passkey signs in from any call the account
// holds (and any SSID of one), also after the active call changes. Each finish answers its own begin's
// challenge, a credential id registers once, an email given at registration binds only once confirmed, the
// account import is throttled, and the operator sees whose account a verification lands on.
import { describe, it, expect } from "vitest";
import {
  authEnv,
  call,
  emailSignup,
  newAuthenticator,
  passkeyLogin,
  passkeyLoginFinish,
  passkeyRegister,
  passkeyRegisterFinish,
  type Authenticator,
} from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const OPERATOR = { "x-operator-secret": "test-operator-secret" };

/** Passkey registration that gives an email at begin, the way the sign-in panel does. */
async function registerWithEmail(env: Env, callsign: string, a: Authenticator, email: string) {
  const begin = await call(env, "POST", "/auth/passkey/register/begin", { callsign, email });
  expect(begin.status).toBe(200);
  return passkeyRegisterFinish(env, callsign, a, begin.data.challenge);
}

describe("passkey sign-in follows the account", () => {
  it("signs in with the old call, the new active call and an SSID after a switch", async () => {
    const env = authEnv();
    const key = await newAuthenticator();
    const reg = await passkeyRegister(env, "OE8APR", key);
    expect(reg.status).toBe(200);

    // an SSID of the active call signs in as that SSID
    const ssid = await passkeyLogin(env, "OE8APR-9", key);
    expect(ssid.status).toBe(200);
    expect(ssid.data.callsign).toBe("OE8APR-9");

    const sw = await call(env, "POST", "/auth/callsign", { callsign: "OE8NEW" }, { cookie: reg.cookie });
    expect(sw.status).toBe(200);
    // signed out: the switch ended every older session
    expect((await call(env, "GET", "/auth/session", undefined, { cookie: reg.cookie })).data.callsign).toBeNull();

    for (const typed of ["OE8APR", "OE8NEW", "OE8APR-9"]) {
      const claim = await call(env, "POST", "/auth/claim", { callsign: typed });
      expect(claim.data).toMatchObject({ exists: true, hasPasskey: true });
      const login = await passkeyLogin(env, typed, key);
      expect(login.status, typed).toBe(200);
      // signing in never changes which call the account operates
      expect(login.data.callsign).toBe("OE8NEW");
      const who = await call(env, "GET", "/auth/session", undefined, { cookie: login.cookie });
      expect(who.data.callsign).toBe("OE8NEW");
    }
    const ssidOfActive = await passkeyLogin(env, "OE8NEW-7", key);
    expect(ssidOfActive.data.callsign).toBe("OE8NEW-7");

    const list = await call(env, "GET", "/auth/passkeys", undefined, { cookie: ssidOfActive.cookie });
    expect(list.data.passkeys).toHaveLength(1);
  });

  it("another account's passkey does not sign in to a call it does not hold", async () => {
    const env = authEnv();
    const mine = await newAuthenticator();
    await passkeyRegister(env, "OE8ONE", mine);
    await passkeyRegister(env, "OE8TWO", await newAuthenticator());
    expect((await passkeyLogin(env, "OE8TWO", mine)).status).toBe(400);
  });
});

describe("a credential id registers once", () => {
  it("refuses a second registration of the same passkey, for a new call or the same account", async () => {
    const env = authEnv();
    const key = await newAuthenticator();
    const first = await passkeyRegister(env, "OE8DUP", key);
    expect(first.status).toBe(200);
    const again = await passkeyRegister(env, "OE8DUP", key, { cookie: first.cookie });
    expect(again.status).toBe(409);
    const elsewhere = await passkeyRegister(env, "OE8OTH", key);
    expect(elsewhere.status).toBe(409);
    // the refused registration opened no account for the new call
    expect((await call(env, "POST", "/auth/claim", { callsign: "OE8OTH" })).data.exists).toBe(false);
    // and the passkey still signs in to the account that registered it
    expect((await passkeyLogin(env, "OE8DUP", key)).data.callsign).toBe("OE8DUP");
  });
});

describe("each finish answers its own challenge", () => {
  it("other begins for the same call never displace the holder's ceremony", async () => {
    const env = authEnv();
    const key = await newAuthenticator();
    await passkeyRegister(env, "OE8CHL", key);
    const mine = await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8CHL" });
    for (let i = 0; i < 5; i++)
      await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8CHL" }, {}, `203.0.113.${i + 1}`);
    expect((await passkeyLoginFinish(env, "OE8CHL", key, mine.data.challenge)).status).toBe(200);
  });

  it("a challenge completes one finish, and only for the call it was begun for", async () => {
    const env = authEnv();
    const key = await newAuthenticator();
    await passkeyRegister(env, "OE8ONC", key);
    await passkeyRegister(env, "OE8OTR", await newAuthenticator());
    const other = await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8OTR" });
    expect((await passkeyLoginFinish(env, "OE8ONC", key, other.data.challenge)).status).toBe(400);

    const begin = await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8ONC" });
    expect((await passkeyLoginFinish(env, "OE8ONC", key, begin.data.challenge)).status).toBe(200);
    const replay = await passkeyLoginFinish(env, "OE8ONC", key, begin.data.challenge);
    expect(replay.status).toBe(400);
    expect(replay.data.error).toBe("no pending login");
  });
});

describe("an email given at passkey registration binds once confirmed", () => {
  it("waits, is no way in, then binds on the confirmation link", async () => {
    const env = authEnv();
    const key = await newAuthenticator();
    const reg = await registerWithEmail(env, "OE8PEN", key, "Pen@Example.test");
    expect(reg.status).toBe(200);
    expect(reg.data.emailPending).toBe(true);
    expect(reg.data.devToken).toMatch(/^[0-9a-f]{64}$/);

    const who = await call(env, "GET", "/auth/session", undefined, { cookie: reg.cookie });
    expect(who.data).toMatchObject({ email: null, pendingEmail: "pen@example.test" });
    const list = await call(env, "GET", "/auth/passkeys", undefined, { cookie: reg.cookie });
    expect(list.data).toMatchObject({ hasEmail: false, emailPending: true });
    // the only passkey stays: a waiting address is no way back in
    const id = Buffer.from(key.credId).toString("base64url");
    const del = await call(env, "DELETE", `/auth/passkeys/${id}`, undefined, { cookie: reg.cookie });
    expect(del.status).toBe(409);
    // an email link for the waiting address does not sign in to the account
    const start = await call(env, "POST", "/auth/email/start", { email: "pen@example.test" });
    expect(start.status).toBe(400);

    const confirm = await call(env, "POST", "/auth/email/verify", { token: reg.data.devToken });
    expect(confirm.status).toBe(200);
    expect(confirm.data.callsign).toBe("OE8PEN");
    const after = await call(env, "GET", "/auth/session", undefined, { cookie: confirm.cookie });
    expect(after.data).toMatchObject({ callsign: "OE8PEN", email: "pen@example.test", pendingEmail: null });
    const login = await call(env, "POST", "/auth/email/start", { email: "pen@example.test" });
    expect(login.data.purpose).toBe("login");
  });

  it("an address confirmed on one account is never bound to another", async () => {
    const env = authEnv();
    const a = await registerWithEmail(env, "OE8AAA", await newAuthenticator(), "same@example.test");
    const b = await registerWithEmail(env, "OE8BBB", await newAuthenticator(), "same@example.test");
    expect((await call(env, "POST", "/auth/email/verify", { token: a.data.devToken })).status).toBe(200);
    expect((await call(env, "POST", "/auth/email/verify", { token: b.data.devToken })).status).toBe(409);
    const who = await call(env, "GET", "/auth/session", undefined, { cookie: b.cookie });
    expect(who.data.email).toBeNull();
  });

  it("an address that already signs in to an account stays with that account", async () => {
    const env = authEnv();
    await emailSignup(env, "taken@example.test", "OE8TKN");
    const late = await registerWithEmail(env, "OE8LAT", await newAuthenticator(), "taken@example.test");
    expect(late.status).toBe(200);
    expect((await call(env, "POST", "/auth/email/verify", { token: late.data.devToken })).status).toBe(409);
  });
});

describe("account import is throttled per address", () => {
  it("answers 429 past five imports an hour from one address", async () => {
    const env = authEnv();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(env, "POST", "/api/account/import", {})).status);
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
    expect((await call(env, "POST", "/api/account/import", {}, {}, "192.0.2.99")).status).toBe(400);
  });
});

describe("operator verification names the holding account", () => {
  it("previews the holder without verifying, then verifies and names it again", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8SYS" });
    const reg = await passkeyRegister(env, "OE8SYS", await newAuthenticator());
    const preview = await call(env, "POST", "/verify/operator", { callsign: "OE8SYS", preview: true }, OPERATOR);
    expect(preview.status).toBe(200);
    expect(preview.data.verified).toBe(false);
    expect(preview.data.holder).toMatchObject({ activeCallsign: "OE8SYS", passkeys: 1, email: false });
    expect(typeof preview.data.holder.accountId).toBe("string");
    const st = await call(env, "GET", "/verify/aprs/status?callsign=OE8SYS");
    expect(st.data.verified).toBe(false);

    const done = await call(env, "POST", "/verify/operator", { callsign: "OE8SYS" }, OPERATOR);
    expect(done.data).toMatchObject({ verified: true, holder: { accountId: preview.data.holder.accountId } });
    expect(reg.status).toBe(200);
  });

  it("names no holder for a call no account holds", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8NOB" });
    const preview = await call(env, "POST", "/verify/operator", { callsign: "OE8NOB", preview: true }, OPERATOR);
    expect(preview.data.holder).toBeNull();
  });
});
