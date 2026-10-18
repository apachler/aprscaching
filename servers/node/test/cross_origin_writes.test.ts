// SPDX-License-Identifier: AGPL-3.0-or-later
// A write that rides the session cookie must come from the instance's own page or a configured app origin.
// SameSite=Lax keeps the cookie off cross-site requests only: a page on another port of the same host, or on a
// sibling subdomain, is same-site and the browser sends the cookie with its POST. A text/plain body needs no
// preflight, so the Origin and Sec-Fetch-Site headers are what tells such a write apart.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, ORIGIN } from "./helpers/authflow.js";

const pending = async (env: Env) =>
  (
    await env.DB.prepare("SELECT pending_email FROM accounts WHERE callsign = 'OE8APR'").first<{
      pending_email: string | null;
    }>()
  )?.pending_email ?? null;

const change = (env: Env, cookie: string, headers: Record<string, string>) =>
  call(env, "POST", "/auth/email/change", { email: "attacker@example.test" }, { cookie, ...headers });

describe("a cookie-authenticated write from another origin", () => {
  it("is refused from another port of the same host, sent as text/plain", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "op@example.test", "OE8APR");
    const r = await change(env, me.cookie, { origin: "https://gw.test:3000", "content-type": "text/plain" });
    expect(r.status).toBe(403);
    expect(await pending(env)).toBeNull();
  });

  it("is refused when the browser says it came from a sibling site", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "op@example.test", "OE8APR");
    const r = await change(env, me.cookie, { origin: "https://grafana.gw.test", "sec-fetch-site": "same-site" });
    expect(r.status).toBe(403);
    // the browser's word counts even when no Origin header is sent
    expect((await change(env, me.cookie, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await pending(env)).toBeNull();
  });

  it("goes through from the instance's own page and from a client that sends no Origin", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "op@example.test", "OE8APR");
    expect((await change(env, me.cookie, { origin: ORIGIN, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(await pending(env)).toBe("attacker@example.test");
    const other = await call(env, "POST", "/auth/email/change", { email: "two@example.test" }, { cookie: me.cookie });
    expect(other.status).toBe(200);
  });

  it("goes through from a configured app origin on another site", async () => {
    const env = authEnv({ CORS_ORIGINS: "https://app.example.org" });
    const me = await emailSignup(env, "op@example.test", "OE8APR");
    const r = await change(env, me.cookie, { origin: "https://app.example.org", "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(200);
  });

  it("leaves a request without the session cookie alone", async () => {
    const env = authEnv();
    const r = await call(
      env,
      "POST",
      "/auth/email/start",
      { email: "new@example.test", callsign: "DL1ABC" },
      { origin: "https://elsewhere.test", "sec-fetch-site": "cross-site" },
    );
    expect(r.status).toBe(200);
  });
});
