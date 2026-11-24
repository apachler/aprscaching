// SPDX-License-Identifier: AGPL-3.0-or-later
// A ham signs in on several devices. Each device holds its own passkey, added from a session of the same
// account; the account lists and removes them, and never loses its last way in.
import { describe, it, expect } from "vitest";
import {
  authEnv,
  call,
  emailSignup,
  newAuthenticator,
  passkeyLogin,
  passkeyRegister,
  passkeyRegisterFinish,
} from "./helpers/authflow.js";

describe("passkeys per device", () => {
  it("a signed-in holder adds a second device's passkey, and both sign in", async () => {
    const env = authEnv();
    const phone = await newAuthenticator();
    const first = await passkeyRegister(env, "OE1DEV", phone);
    expect(first.status).toBe(200);
    const laptop = await newAuthenticator();
    const second = await passkeyRegister(env, "OE1DEV", laptop, { cookie: first.cookie });
    expect(second.status).toBe(200);
    expect((await passkeyLogin(env, "OE1DEV", phone)).status).toBe(200);
    expect((await passkeyLogin(env, "OE1DEV", laptop)).status).toBe(200);
    const list = await call(env, "GET", "/auth/passkeys", undefined, { cookie: second.cookie });
    expect(list.status).toBe(200);
    expect(list.data.passkeys).toHaveLength(2);
    expect(list.data.callsign).toBe("OE1DEV");
  });

  it("without a session of that account, adding a passkey to a held call is refused", async () => {
    const env = authEnv();
    const owner = await passkeyRegister(env, "OE1OWN", await newAuthenticator());
    expect(owner.status).toBe(200);
    const stranger = await emailSignup(env, "stranger@example.test", "OE1STR");
    expect((await passkeyRegister(env, "OE1OWN", await newAuthenticator())).status).toBe(409);
    expect((await passkeyRegister(env, "OE1OWN", await newAuthenticator(), { cookie: stranger.cookie })).status).toBe(
      409,
    );
    const list = await call(env, "GET", "/auth/passkeys", undefined, { cookie: owner.cookie });
    expect(list.data.passkeys).toHaveLength(1);
  });

  it("a passkey add binds to the account that began it, never to whoever holds the call at finish", async () => {
    const env = authEnv();
    const prev = await passkeyRegister(env, "OE1RAC", await newAuthenticator());
    expect(prev.status).toBe(200);
    const licensee = await emailSignup(env, "licensee@example.test", "OE1LIC");
    expect(licensee.status).toBe(200);
    const victimId = (await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = 'OE1LIC'").first<{
      account_id: string;
    }>())!.account_id;
    // the previous holder begins an add, then the call changes hands before finish (the begin's stash survives)
    const begin = await call(env, "POST", "/auth/passkey/register/begin", { callsign: "OE1RAC" }, { cookie: prev.cookie });
    expect(begin.status).toBe(200);
    await env.DB.prepare("UPDATE account_callsigns SET account_id = ? WHERE callsign = 'OE1RAC'").bind(victimId).run();
    const fin = await passkeyRegisterFinish(env, "OE1RAC", await newAuthenticator(), begin.data.challenge, {
      cookie: prev.cookie,
    });
    expect(fin.status).toBe(400);
    expect(fin.cookie).toBe("");
    const onVictim = await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials WHERE account_id = ?")
      .bind(victimId)
      .first<{ n: number }>();
    expect(onVictim?.n).toBe(0);
  });

  it("a passkey add finishes only with a session of the account that began it", async () => {
    const env = authEnv();
    const owner = await passkeyRegister(env, "OE1FIN", await newAuthenticator());
    const begin = await call(env, "POST", "/auth/passkey/register/begin", { callsign: "OE1FIN" }, { cookie: owner.cookie });
    expect(begin.status).toBe(200);
    const fin = await passkeyRegisterFinish(env, "OE1FIN", await newAuthenticator(), begin.data.challenge);
    expect(fin.status).toBe(400);
    expect(fin.cookie).toBe("");
  });

  it("adding a passkey keeps the session on the call it was using", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "multi@example.test", "OE1PRI");
    const sw = await call(env, "POST", "/auth/callsign", { callsign: "OE1SEC" }, { cookie: s.cookie });
    expect(sw.status).toBe(200);
    const cookie = sw.cookie || s.cookie;
    const add = await passkeyRegister(env, "OE1PRI", await newAuthenticator(), { cookie });
    expect(add.status).toBe(200);
    expect(add.data.callsign).toBe("OE1SEC");
    const who = await call(env, "GET", "/auth/session", undefined, { cookie: add.cookie });
    expect(who.data.callsign).toBe("OE1SEC");
  });

  it("a lost device's passkey is removed and no longer signs in", async () => {
    const env = authEnv();
    const phone = await newAuthenticator();
    const first = await passkeyRegister(env, "OE1LST", phone);
    const laptop = await newAuthenticator();
    const second = await passkeyRegister(env, "OE1LST", laptop, { cookie: first.cookie });
    const list = await call(env, "GET", "/auth/passkeys", undefined, { cookie: second.cookie });
    const lost = list.data.passkeys.find(
      (p: { id: string }) => p.id === Buffer.from(phone.credId).toString("base64url"),
    );
    const del = await call(env, "DELETE", `/auth/passkeys/${lost.id}`, undefined, { cookie: second.cookie });
    expect(del.status).toBe(200);
    expect((await passkeyLogin(env, "OE1LST", phone)).status).not.toBe(200);
    expect((await passkeyLogin(env, "OE1LST", laptop)).status).toBe(200);
  });

  it("the last passkey of an account without an email stays", async () => {
    const env = authEnv();
    const only = await newAuthenticator();
    const s = await passkeyRegister(env, "OE1ONE", only);
    const id = Buffer.from(only.credId).toString("base64url");
    const del = await call(env, "DELETE", `/auth/passkeys/${id}`, undefined, { cookie: s.cookie });
    expect(del.status).toBe(409);
    expect((await passkeyLogin(env, "OE1ONE", only)).status).toBe(200);
  });

  it("another account's passkey cannot be removed", async () => {
    const env = authEnv();
    const victimKey = await newAuthenticator();
    await passkeyRegister(env, "OE1VKY", victimKey);
    const other = await emailSignup(env, "other@example.test", "OE1OTH");
    const id = Buffer.from(victimKey.credId).toString("base64url");
    const del = await call(env, "DELETE", `/auth/passkeys/${id}`, undefined, { cookie: other.cookie });
    expect(del.status).toBe(404);
    expect((await passkeyLogin(env, "OE1VKY", victimKey)).status).toBe(200);
  });
});
