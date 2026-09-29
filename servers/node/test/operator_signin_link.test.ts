// SPDX-License-Identifier: AGPL-3.0-or-later
// The operator-issued sign-in link: the sign-in path for an instance with neither passkeys (no https
// origin) nor email. The operator's script mints a single-use, 15-minute link with OPERATOR_SECRET; the
// link runs through the same GET-confirm / POST-consume step as an email link, so opening it signs nobody
// in. On an instance that has another sign-in path the link is limited to ADMIN_CALLSIGNS, which bounds
// what a leaked operator secret can reach there.
import { describe, it, expect } from "vitest";
import { call, emailSignup } from "./helpers/authflow.js";
import { instanceEnv, serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const OP = { "x-operator-secret": "test-operator-secret" };
const LAN = "http://192.168.1.10";
const LOOPBACK = "http://127.0.0.1:8080";

/** An off-grid LAN instance: plain http, no email provider. */
const offGrid = (extra: Record<string, unknown> = {}) =>
  instanceEnv("lan.test", null, { APP_URL: LAN, ADMIN_CALLSIGNS: "OE8APR", ...extra });

/** Mint a link the way the operator's script does on the box itself: over loopback. */
async function mint(env: Env, callsign: string, headers: Record<string, string> = OP, url = LOOPBACK) {
  const res = await serve(env)(
    new Request(`${url}/auth/operator-link`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ callsign }),
    }),
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

/** Confirm a link the way the confirm page's form does: a same-origin form POST. */
const confirm = (env: Env, link: string) =>
  serve(env)(
    new Request(new URL("/auth/email/verify", link), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(link).origin,
        "x-real-ip": "192.0.2.10",
      },
      body: new URLSearchParams({ token: tokenOf(link) }).toString(),
    }),
  );

describe("POST /auth/operator-link — authorisation", () => {
  it("refuses a missing or wrong operator secret, and every request while none is configured", async () => {
    const env = offGrid();
    expect((await mint(env, "OE8APR", {})).status).toBe(401);
    expect((await mint(env, "OE8APR", { "x-operator-secret": "nope" })).status).toBe(401);
    expect((await mint(env, "OE8APR", { "x-ingest-secret": "test-ingest-secret" })).status).toBe(401);
    expect((await mint(offGrid({ OPERATOR_SECRET: "" }), "OE8APR")).status).toBe(401);
  });

  it("refuses a malformed or reserved call", async () => {
    const env = offGrid();
    expect((await mint(env, "x")).status).toBe(400);
    expect((await mint(env, "APRSCG")).status).toBe(400);
  });
});

describe("operator sign-in link — off-grid instance", () => {
  it("links to the app origin, and opening it consumes nothing", async () => {
    const env = offGrid();
    const r = await mint(env, "OE8APR");
    expect(r.status).toBe(200);
    expect(r.data.link).toMatch(new RegExp(`^${LAN}/auth/email/verify\\?token=[0-9a-f]{64}$`));
    expect(r.data.expiresIn).toBe(900);
    const page = await serve(env)(new Request(r.data.link, { headers: { accept: "text/html" } }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('action="/auth/email/verify"');
    const ok = await confirm(env, r.data.link);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("set-cookie")).toMatch(/^acs=/);
    // a plain-http origin cannot store a Secure cookie, so a declared http APP_URL gets one without it
    expect(ok.headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("creates the account for a new call, unverified, and the link is single-use", async () => {
    const env = offGrid();
    const r = await mint(env, "oe8club");
    expect(r.data.callsign).toBe("OE8CLUB");
    const first = await call(env, "POST", "/auth/email/verify", { token: tokenOf(r.data.link) });
    expect(first.status).toBe(200);
    expect(first.data.callsign).toBe("OE8CLUB");
    const me = await call(env, "GET", "/auth/session", undefined, { cookie: first.cookie });
    expect(me.data.callsign).toBe("OE8CLUB");
    const held = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign='OE8CLUB'").first();
    expect(held).not.toBeNull();
    const v = await env.DB.prepare("SELECT 1 FROM callsign_verifications WHERE callsign='OE8CLUB'").first();
    expect(v).toBeNull(); // a sign-in link is not callsign control-verification
    expect((await call(env, "POST", "/auth/email/verify", { token: tokenOf(r.data.link) })).status).toBe(400);
  });

  it("signs in the existing account that holds the call's base call", async () => {
    const env = offGrid({ ALLOW_DEV_TOKENS: "1" });
    const signup = await emailSignup(env, "mem@example.test", "OE8MEM");
    expect(signup.status).toBe(200);
    const r = await mint(env, "OE8MEM-7");
    const s = await call(env, "POST", "/auth/email/verify", { token: tokenOf(r.data.link) });
    expect(s.status).toBe(200);
    expect(s.data.callsign).toBe("OE8MEM");
    const accounts = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
    expect(accounts?.n).toBe(1);
  });

  it("expires after 15 minutes", async () => {
    const env = offGrid();
    const r = await mint(env, "OE8OLD");
    await env.DB.prepare("UPDATE email_tokens SET created_at = created_at - 901 WHERE token = ?")
      .bind(tokenOf(r.data.link))
      .run();
    expect((await call(env, "POST", "/auth/email/verify", { token: tokenOf(r.data.link) })).status).toBe(400);
  });

  it("a foreign page cannot confirm the link (no login CSRF)", async () => {
    const env = offGrid();
    const r = await mint(env, "OE8APR");
    const res = await serve(env)(
      new Request(`${LAN}/auth/email/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" },
        body: new URLSearchParams({ token: tokenOf(r.data.link) }).toString(),
      }),
    );
    expect(res.status).toBe(403);
    expect((await confirm(env, r.data.link)).status).toBe(303); // still unspent
  });
});

describe("operator sign-in link — instance with another sign-in path", () => {
  it("serves only ADMIN_CALLSIGNS calls when passkeys work (https APP_URL)", async () => {
    const env = offGrid({ APP_URL: "https://gw.test" });
    expect((await mint(env, "OE8MEM")).status).toBe(403);
    const r = await mint(env, "OE8APR");
    expect(r.status).toBe(200);
    expect(r.data.link.startsWith("https://gw.test/auth/email/verify?token=")).toBe(true);
    const ok = await confirm(env, r.data.link);
    expect(ok.headers.get("set-cookie")).toMatch(/; Secure;/);
  });

  it("names the gateway's public origin when the script reaches it there (app on another host)", async () => {
    const env = offGrid({ APP_URL: "https://app.test" });
    const r = await mint(env, "OE8APR", OP, "https://api.test");
    expect(r.data.link.startsWith("https://api.test/auth/email/verify?token=")).toBe(true);
  });

  it("serves only ADMIN_CALLSIGNS calls when email is configured", async () => {
    const env = offGrid({ EMAIL_FROM: "op@lan.test", EMAIL_API_KEY: "re_test" });
    expect((await mint(env, "OE8MEM")).status).toBe(403);
    expect((await mint(env, "OE8APR-9")).status).toBe(200);
  });
});
