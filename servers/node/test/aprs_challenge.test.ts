// SPDX-License-Identifier: AGPL-3.0-or-later
// Starting an APRS control-verification challenge: a signed-in caller may only challenge a call its
// account holds, a fresh challenge never revokes an existing verification, and starts are throttled
// per account and per callsign so nobody can flood a station with codes over APRS.
import { describe, it, expect } from "vitest";
import { authEnv, call, controlVerify, emailSignup, lastCode } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const verified = async (env: Env, cs: string) =>
  (await call(env, "GET", `/verify/aprs/status?callsign=${cs}`)).data?.verified === true;

describe("APRS challenge start", () => {
  it("a session cannot start a challenge for a call its account does not hold", async () => {
    const env = authEnv();
    await emailSignup(env, "owner@example.test", "OE8APR");
    const other = await emailSignup(env, "other@example.test", "DL1AAA");
    const r = await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: other.cookie });
    expect(r.status).toBe(403);
    const unheld = await call(env, "POST", "/verify/aprs/start", { callsign: "W1AW" }, { cookie: other.cookie });
    expect(unheld.status).toBe(403);
    const queued = await env.DB.prepare("SELECT COUNT(*) AS n FROM aprs_outbox").first<{ n: number }>();
    expect(queued!.n).toBe(0);
  });

  it("the holder can start and confirm a challenge for its own call", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "owner@example.test", "OE8APR");
    expect((await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: me.cookie })).status).toBe(
      200,
    );
    const code = await lastCode(env, "OE8APR");
    const conf = await call(env, "POST", "/verify/aprs/confirm", { callsign: "OE8APR", code }, { cookie: me.cookie });
    expect(conf.data.verified).toBe(true);
    expect(await verified(env, "OE8APR")).toBe(true);
  });

  it("a new challenge on a verified call keeps it verified, even after wrong guesses", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "owner@example.test", "OE8APR");
    await controlVerify(env, "OE8APR");
    expect(await verified(env, "OE8APR")).toBe(true);
    expect((await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: me.cookie })).status).toBe(
      200,
    );
    expect(await verified(env, "OE8APR")).toBe(true);
    for (let i = 0; i < 6; i++)
      await call(env, "POST", "/verify/aprs/confirm", { callsign: "OE8APR", code: "000000" }, { cookie: me.cookie });
    expect(await verified(env, "OE8APR")).toBe(true);
    const held = await env.DB.prepare("SELECT verified FROM account_callsigns WHERE callsign='OE8APR'").first<{
      verified: number;
    }>();
    expect(held!.verified).toBe(1);
  });

  it("a used code cannot be replayed", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "owner@example.test", "OE8APR");
    await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: me.cookie });
    const code = await lastCode(env, "OE8APR");
    expect(
      (await call(env, "POST", "/verify/aprs/confirm", { callsign: "OE8APR", code }, { cookie: me.cookie })).data
        .verified,
    ).toBe(true);
    const again = await call(env, "POST", "/verify/aprs/confirm", { callsign: "OE8APR", code }, { cookie: me.cookie });
    expect(again.status).toBe(400);
  });

  it("starts are rate limited per callsign and per account", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "owner@example.test", "OE8APR");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push(
        (await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: me.cookie })).status,
      );
    expect(statuses).toContain(429);
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM aprs_outbox").first<{ n: number }>();
    expect(sent!.n).toBeLessThan(8);

    // the account budget spans its calls: switching to a second held call does not reset it
    await call(env, "POST", "/auth/callsigns", { callsign: "OE8XYZ" }, { cookie: me.cookie });
    const more: number[] = [];
    for (let i = 0; i < 12; i++)
      more.push((await call(env, "POST", "/verify/aprs/start", { callsign: "OE8XYZ" }, { cookie: me.cookie })).status);
    expect(more).toContain(429);
  });
});
