// SPDX-License-Identifier: AGPL-3.0-or-later
// Starting an RF control-verification challenge: a signed-in caller may only challenge a call its
// account holds, and starts are throttled per account and per callsign so nobody can churn codes.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

describe("RF verification challenge start", () => {
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

  it("starts are rate limited per callsign and per account", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "owner@example.test", "OE8APR");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push(
        (await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: me.cookie })).status,
      );
    expect(statuses).toContain(429);

    // the account budget spans its calls: switching to a second held call does not reset it
    await call(env, "POST", "/auth/callsigns", { callsign: "OE8XYZ" }, { cookie: me.cookie });
    const more: number[] = [];
    for (let i = 0; i < 12; i++)
      more.push((await call(env, "POST", "/verify/aprs/start", { callsign: "OE8XYZ" }, { cookie: me.cookie })).status);
    expect(more).toContain(429);
  });
});
