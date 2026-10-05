// SPDX-License-Identifier: AGPL-3.0-or-later
// A new account shares nothing it did not choose to: the email digest, the public profile card, the APRS-IS
// announce and the near-cache radio message all start off, and a profile save without the switch stays hidden.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

describe("a new account's defaults", () => {
  it("start with every sharing setting off", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "new@example.test", "OE8NEW");
    expect(s.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT notify_digest, profile_public, announce_is, near_radio, public_contact FROM accounts WHERE callsign = ?",
    )
      .bind("OE8NEW")
      .first();
    expect(row).toEqual({ notify_digest: 0, profile_public: 0, announce_is: 0, near_radio: 0, public_contact: null });

    const prefs = await call(env, "GET", "/api/notify/prefs", undefined, { cookie: s.cookie });
    expect(prefs.data).toMatchObject({ digest: false, hasEmail: true });
    const mine = await call(env, "GET", "/api/my/profile", undefined, { cookie: s.cookie });
    expect(mine.data.profile.profilePublic).toBe(false);
  });

  it("the digest and the profile card show only once switched on", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "new@example.test", "OE8NEW");
    // a save that names no switch keeps the card hidden
    await call(env, "POST", "/auth/profile", { displayName: "Andi" }, { cookie: s.cookie });
    expect((await call(env, "GET", "/api/profile/OE8NEW")).data.profile).toBeUndefined();
    await call(env, "POST", "/auth/profile", { displayName: "Andi", profilePublic: true }, { cookie: s.cookie });
    expect((await call(env, "GET", "/api/profile/OE8NEW")).data.profile).toEqual({ displayName: "Andi" });

    // a POST that names no value leaves the digest off
    expect((await call(env, "POST", "/api/notify/prefs", {}, { cookie: s.cookie })).data.digest).toBe(false);
    expect((await call(env, "POST", "/api/notify/prefs", { digest: true }, { cookie: s.cookie })).data.digest).toBe(
      true,
    );
  });
});
