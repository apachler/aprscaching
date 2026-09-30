// SPDX-License-Identifier: AGPL-3.0-or-later
// Visitors on an off-grid station's hotspot. The owner's app origin is http://localhost (passkeys work
// there), so an operator link normally serves only ADMIN_CALLSIGNS calls and names localhost, which no
// visitor's phone can open. With OPERATOR_LINKS_FOR_ANY_CALL=1 the operator mints a link for any call,
// and `base` names the https hotspot origin the phone does reach. The session works there, a foreign
// origin still cannot confirm a link, and nothing about find trust changes.
import { describe, it, expect } from "vitest";
import { instanceEnv, serve, addCache } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const OP = { "x-operator-secret": "test-operator-secret" };
const APP = "http://localhost:8787";
const HOTSPOT = "https://192.168.43.1:8443";

/** A Pocket station: loopback APP_URL, the https listener on 8443, the operator is OE8APR. */
const pocket = (extra: Record<string, unknown> = {}) =>
  instanceEnv("localhost", null, {
    APP_URL: APP,
    ADMIN_CALLSIGNS: "OE8APR",
    HTTPS_LISTENER_PORT: "8443",
    ...extra,
  });
const anyCall = (extra: Record<string, unknown> = {}) => pocket({ OPERATOR_LINKS_FOR_ANY_CALL: "1", ...extra });

/** Mint over loopback, the way tools/admin/signin-link.mjs does on the station. */
async function mint(env: Env, body: Record<string, unknown>) {
  const res = await serve(env)(
    new Request("http://127.0.0.1:8787/auth/operator-link", {
      method: "POST",
      headers: { "content-type": "application/json", ...OP },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

/** A request as the visitor's browser sends it on the hotspot origin. */
const visitor = (
  env: Env,
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
) =>
  serve(env)(
    new Request(`${HOTSPOT}${path}`, {
      method,
      headers: { "x-real-ip": "192.168.43.77", ...init.headers },
      body: init.body,
    }),
  );

const confirm = (env: Env, token: string, origin = HOTSPOT) =>
  visitor(env, "POST", "/auth/email/verify", {
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ token }).toString(),
  });

describe("visitor links need the explicit setting", () => {
  it("refuses a non-admin call without OPERATOR_LINKS_FOR_ANY_CALL, and mints it with the setting", async () => {
    expect((await mint(pocket(), { callsign: "OE8VIS" })).status).toBe(403);
    expect((await mint(pocket({ OPERATOR_LINKS_FOR_ANY_CALL: "0" }), { callsign: "OE8VIS" })).status).toBe(403);
    const r = await mint(anyCall(), { callsign: "OE8VIS" });
    expect(r.status).toBe(200);
    expect(r.data.link.startsWith(`${APP}/auth/email/verify?token=`)).toBe(true);
  });

  it("still needs the operator secret", async () => {
    const res = await serve(anyCall())(
      new Request("http://127.0.0.1:8787/auth/operator-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callsign: "OE8VIS", base: HOTSPOT }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("the link's origin (base)", () => {
  it("names the hotspot origin the operator asks for", async () => {
    const r = await mint(anyCall(), { callsign: "OE8VIS", base: HOTSPOT });
    expect(r.status).toBe(200);
    expect(r.data.link).toMatch(/^https:\/\/192\.168\.43\.1:8443\/auth\/email\/verify\?token=[0-9a-f]{64}$/);
    const own = await mint(anyCall(), { callsign: "OE8APR", base: `${APP}/` });
    expect(own.data.link.startsWith(`${APP}/auth/email/verify?token=`)).toBe(true);
  });

  it("an admin's own link may name the hotspot origin without the setting", async () => {
    const r = await mint(pocket(), { callsign: "OE8APR", base: HOTSPOT });
    expect(r.status).toBe(200);
    expect(r.data.link.startsWith(`${HOTSPOT}/`)).toBe(true);
  });

  it("refuses any other origin, and mints nothing for it", async () => {
    const env = anyCall();
    for (const base of [
      "https://8.8.8.8:8443",
      "https://192.168.43.1:9443",
      "http://192.168.43.1:8443",
      "https://evil.test",
      "https://192.168.43.1:8443/phish",
      42,
    ]) {
      const r = await mint(env, { callsign: "OE8VIS", base });
      expect(r.status, String(base)).toBe(400);
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_tokens").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("refuses the hotspot origin while no https listener runs", async () => {
    const r = await mint(anyCall({ HTTPS_LISTENER_PORT: undefined }), { callsign: "OE8VIS", base: HOTSPOT });
    expect(r.status).toBe(400);
  });
});

describe("the visitor's session on the hotspot origin", () => {
  it("opens the confirm page, signs in on a same-origin confirm and returns to the hotspot origin", async () => {
    const env = anyCall();
    const r = await mint(env, { callsign: "oe8vis", base: HOTSPOT });
    const page = await serve(env)(new Request(r.data.link, { headers: { accept: "text/html" } }));
    expect(page.status).toBe(200);
    const ok = await confirm(env, tokenOf(r.data.link));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`${HOTSPOT}/`);
    const cookie = /(acs=[^;]*)/.exec(ok.headers.get("set-cookie") ?? "")![1]!;
    const me = await visitor(env, "GET", "/auth/session", { headers: { cookie, origin: HOTSPOT } });
    expect(((await me.json()) as { callsign: string }).callsign).toBe("OE8VIS");
    // a new visitor's account is unverified, as for any user
    const v = await env.DB.prepare("SELECT 1 FROM callsign_verifications WHERE callsign='OE8VIS'").first();
    expect(v).toBeNull();
  });

  it("a random origin, or another device on the hotspot, still cannot confirm the link", async () => {
    const env = anyCall();
    const r = await mint(env, { callsign: "OE8VIS", base: HOTSPOT });
    for (const origin of ["https://evil.test", "https://192.168.43.99:8443", "null"])
      expect((await confirm(env, tokenOf(r.data.link), origin)).status, origin).toBe(403);
    expect((await confirm(env, tokenOf(r.data.link))).status).toBe(303); // still unspent
  });

  it("gives a foreign origin no credentialed CORS", async () => {
    const res = await visitor(anyCall(), "GET", "/auth/session", { headers: { origin: "https://192.168.43.99:8443" } });
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("returns to APP_URL when the confirm arrives on any other origin", async () => {
    const env = anyCall();
    const r = await mint(env, { callsign: "OE8VIS" });
    const ok = await serve(env)(
      new Request(`${APP}/auth/email/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: APP, "x-real-ip": "127.0.0.1" },
        body: new URLSearchParams({ token: tokenOf(r.data.link) }).toString(),
      }),
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`${APP}/`);
  });
});

describe("trust is unchanged", () => {
  it("a visitor logs finds only as the visitor, and a session find is never Tier A", async () => {
    const env = anyCall();
    const cacheId = await addCache(env);
    const r = await mint(env, { callsign: "OE8VIS", base: HOTSPOT });
    const ok = await confirm(env, tokenOf(r.data.link));
    const cookie = /(acs=[^;]*)/.exec(ok.headers.get("set-cookie") ?? "")![1]!;
    const log = await visitor(env, "POST", `/api/caches/${cacheId}/logs`, {
      headers: { cookie, origin: HOTSPOT, "content-type": "application/json" },
      body: JSON.stringify({ logType: "found", loggerCall: "OE8APR" }),
    });
    expect(log.status).toBeLessThan(300);
    const rows = await env.DB.prepare("SELECT logger_call, tier FROM cache_logs WHERE cache_id=?")
      .bind(cacheId)
      .all<{ logger_call: string; tier: string | null }>();
    expect(rows.results.map((x) => x.logger_call)).toEqual(["OE8VIS"]);
    expect(rows.results[0]!.tier).not.toBe("A");
  });
});
