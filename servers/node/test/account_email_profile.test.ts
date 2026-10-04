// SPDX-License-Identifier: AGPL-3.0-or-later
// A signed-in account adds or changes its email, which waits for confirmation and can be mailed again, and
// reads its own profile with every field and the show/hide switch, so saving never blanks or reveals it.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, newAuthenticator, passkeyLogin, passkeyRegister } from "./helpers/authflow.js";

describe("adding and changing the account email", () => {
  it("adds a first address to a passkey account, which binds once confirmed", async () => {
    const env = authEnv();
    const reg = await passkeyRegister(env, "OE8ADD", await newAuthenticator());
    const add = await call(env, "POST", "/auth/email/change", { email: "Add@Example.test" }, { cookie: reg.cookie });
    expect(add.status).toBe(200);
    expect(add.data).toMatchObject({ ok: true, pendingEmail: "add@example.test" });
    expect(add.data.devToken).toMatch(/^[0-9a-f]{64}$/);
    const who = await call(env, "GET", "/auth/session", undefined, { cookie: reg.cookie });
    expect(who.data).toMatchObject({ email: null, pendingEmail: "add@example.test" });

    const confirm = await call(env, "POST", "/auth/email/verify", { token: add.data.devToken });
    expect(confirm.status).toBe(200);
    const after = await call(env, "GET", "/auth/session", undefined, { cookie: reg.cookie });
    expect(after.data).toMatchObject({ email: "add@example.test", pendingEmail: null });
  });

  it("keeps the confirmed address until the new one is confirmed, and an older link no longer binds", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "old@example.test", "OE8CHG");
    const first = await call(env, "POST", "/auth/email/change", { email: "one@example.test" }, { cookie: s.cookie });
    const second = await call(env, "POST", "/auth/email/change", { email: "two@example.test" }, { cookie: s.cookie });
    expect(second.status).toBe(200);
    const who = await call(env, "GET", "/auth/session", undefined, { cookie: s.cookie });
    expect(who.data).toMatchObject({ email: "old@example.test", pendingEmail: "two@example.test" });
    // the first address is no longer the one the account waits for
    expect((await call(env, "POST", "/auth/email/verify", { token: first.data.devToken })).status).toBe(400);
    expect((await call(env, "POST", "/auth/email/verify", { token: second.data.devToken })).status).toBe(200);
    const after = await call(env, "GET", "/auth/session", undefined, { cookie: s.cookie });
    expect(after.data).toMatchObject({ email: "two@example.test", pendingEmail: null });
  });

  it("giving the confirmed address again drops the waiting one", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "keep@example.test", "OE8KEP");
    await call(env, "POST", "/auth/email/change", { email: "other@example.test" }, { cookie: s.cookie });
    const back = await call(env, "POST", "/auth/email/change", { email: "keep@example.test" }, { cookie: s.cookie });
    expect(back.data).toMatchObject({ ok: true, email: "keep@example.test", pendingEmail: null });
    const who = await call(env, "GET", "/auth/session", undefined, { cookie: s.cookie });
    expect(who.data.pendingEmail).toBeNull();
  });

  it("refuses an address another account holds confirmed, a malformed one, and no session", async () => {
    const env = authEnv();
    await emailSignup(env, "held@example.test", "OE8HLD");
    const s = await emailSignup(env, "mine@example.test", "OE8MIN");
    const taken = await call(env, "POST", "/auth/email/change", { email: "held@example.test" }, { cookie: s.cookie });
    expect(taken.status).toBe(409);
    const bad = await call(env, "POST", "/auth/email/change", { email: "not-an-address" }, { cookie: s.cookie });
    expect(bad.status).toBe(400);
    expect((await call(env, "POST", "/auth/email/change", { email: "x@example.test" })).status).toBe(401);
    expect((await call(env, "POST", "/auth/email/resend", {})).status).toBe(401);
  });

  it("resends for the waiting address only, and both paths share one rate limit", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "rs@example.test", "OE8RES");
    const none = await call(env, "POST", "/auth/email/resend", {}, { cookie: s.cookie });
    expect(none.status).toBe(400);

    const change = await call(env, "POST", "/auth/email/change", { email: "new@example.test" }, { cookie: s.cookie });
    expect(change.status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await call(env, "POST", "/auth/email/resend", {}, { cookie: s.cookie })).status);
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses[4]).toBe(429);

    const resent = await call(env, "POST", "/auth/email/resend", {}, { cookie: s.cookie }, "192.0.2.77");
    expect(resent.status).toBe(429);
  });

  it("a resent link confirms the waiting address", async () => {
    const env = authEnv();
    const reg = await passkeyRegister(env, "OE8RSL", await newAuthenticator());
    await call(env, "POST", "/auth/email/change", { email: "rsl@example.test" }, { cookie: reg.cookie });
    const again = await call(env, "POST", "/auth/email/resend", {}, { cookie: reg.cookie });
    expect(again.data).toMatchObject({ ok: true, pendingEmail: "rsl@example.test" });
    expect((await call(env, "POST", "/auth/email/verify", { token: again.data.devToken })).status).toBe(200);
    const who = await call(env, "GET", "/auth/session", undefined, { cookie: reg.cookie });
    expect(who.data.email).toBe("rsl@example.test");
  });
});

describe("the owner's own profile", () => {
  it("returns every field and the switch while hidden, and an edit keeps it hidden", async () => {
    const env = authEnv();
    const reg = await passkeyRegister(env, "OE8PRF", await newAuthenticator());
    const save = await call(
      env,
      "POST",
      "/auth/profile",
      {
        displayName: "Andi",
        bio: "Portable ops",
        links: [{ label: "web", url: "https://example.test" }],
        profilePublic: false,
      },
      { cookie: reg.cookie },
    );
    expect(save.status).toBe(200);

    // the public profile shows none of it
    const pub = await call(env, "GET", "/api/profile/OE8PRF");
    expect(pub.data.profile).toBeUndefined();

    const mine = await call(env, "GET", "/api/my/profile", undefined, { cookie: reg.cookie });
    expect(mine.status).toBe(200);
    expect(mine.data.profile).toMatchObject({
      displayName: "Andi",
      bio: "Portable ops",
      links: [{ label: "web", url: "https://example.test" }],
      profilePublic: false,
    });
    expect((await call(env, "GET", "/api/my/profile")).status).toBe(401);
  });

  it("an SSID session edits the account's profile", async () => {
    const env = authEnv();
    const key = await newAuthenticator();
    await passkeyRegister(env, "OE8SSP", key);
    const ssid = await passkeyLogin(env, "OE8SSP-9", key);
    expect(ssid.data.callsign).toBe("OE8SSP-9");
    await call(env, "POST", "/auth/profile", { displayName: "Mobile" }, { cookie: ssid.cookie });
    const mine = await call(env, "GET", "/api/my/profile", undefined, { cookie: ssid.cookie });
    expect(mine.data.profile.displayName).toBe("Mobile");
  });
});
