// SPDX-License-Identifier: AGPL-3.0-or-later
// A write that rides the session cookie must come from the instance's own page or a configured app origin.
// SameSite=Lax keeps the cookie off cross-site requests only: a page on another port of the same host, or on a
// sibling subdomain, is same-site and the browser sends the cookie with its POST. A text/plain body needs no
// preflight, so the Origin and Sec-Fetch-Site headers are what tells such a write apart.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import {
  authEnv,
  call,
  emailSignup,
  newAuthenticator,
  ORIGIN,
  passkeyRegister,
  passkeyRegisterFinish,
  signedLogin,
} from "./helpers/authflow.js";

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

  it("leaves a request without the session cookie alone outside the sign-in endpoints", async () => {
    const env = authEnv();
    const r = await call(
      env,
      "POST",
      "/api/ingest",
      { packets: [] },
      { origin: "https://elsewhere.test", "sec-fetch-site": "cross-site" },
    );
    expect(r.data?.error).not.toBe("cross-origin write refused");
  });
});

// A visitor who is not signed in carries no cookie, and the sign-in endpoints issue one. A cross-site form that
// posts the attacker's own passkey assertion would sign the victim's browser into the attacker's account.
describe("a cookie-less sign-in from another origin (login CSRF)", () => {
  const cross = { origin: "https://evil.test", "sec-fetch-site": "cross-site", "content-type": "text/plain" };

  it("refuses a passkey login finish and issues no session", async () => {
    const env = authEnv();
    const a = await newAuthenticator();
    expect((await passkeyRegister(env, "OE8APR", a)).status).toBe(200);
    const begin = await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8APR" });
    expect(begin.status).toBe(200);
    const signed = await signedLogin("OE8APR", a, begin.data.challenge);
    const r = await call(env, "POST", "/auth/passkey/login/finish", signed, cross);
    expect(r.status).toBe(403);
    expect(r.cookie).toBe("");
    // the same assertion from the instance's own page signs in
    const ok = await call(env, "POST", "/auth/passkey/login/finish", signed, { origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(ok.cookie).not.toBe("");
  });

  it("refuses a passkey registration finish and a claim status from another origin", async () => {
    const env = authEnv();
    const a = await newAuthenticator();
    const begin = await call(env, "POST", "/auth/passkey/register/begin", { callsign: "OE8APR" });
    expect(begin.status).toBe(200);
    const r = await passkeyRegisterFinish(env, "OE8APR", a, begin.data.challenge, cross);
    expect(r.status).toBe(403);
    expect(r.cookie).toBe("");
    const st = await call(env, "POST", "/auth/claims/status", { claim: "x" }, cross);
    expect(st.status).toBe(403);
  });

  it("goes through without an Origin header (a non-browser client)", async () => {
    const env = authEnv();
    const r = await call(env, "POST", "/auth/email/start", { email: "new@example.test", callsign: "DL1ABC" });
    expect(r.status).toBe(200);
  });
});
