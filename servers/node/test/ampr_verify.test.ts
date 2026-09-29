// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign control-verification through ampr.org DNS. ARDC delegates `<call>.ampr.org` only after
// reviewing the holder's licence, so a code the holder publishes under that name proves control of the
// call — but only when the answer is DNSSEC-validated: an unvalidated DNS answer can be spoofed on the
// way, and a user's verification never trusts on first use.
import { describe, it, expect, afterEach } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const DOH = "https://dns.example/dns-query";
const env = () => authEnv({ DOH_URL: DOH });

interface Doh {
  status?: number;
  ad?: boolean;
  txt?: string[];
}
/** Stub the DoH resolver; records every queried URL. */
function stubDoh(answer: Doh | (() => Doh)): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(DOH)) throw new Error(`unexpected fetch ${url}`);
    asked.push(url);
    const a = typeof answer === "function" ? answer() : answer;
    const name = new URL(url).searchParams.get("name");
    return new Response(
      JSON.stringify({
        Status: a.status ?? 0,
        AD: a.ad ?? false,
        Answer: (a.txt ?? []).map((t) => ({ name, type: 16, data: `"${t}"` })),
      }),
      { headers: { "content-type": "application/dns-json" } },
    );
  }) as typeof fetch;
  return asked;
}

async function started(e: Env, cs = "OE8APR") {
  const me = await emailSignup(e, `${cs.toLowerCase()}@example.test`, cs);
  const s = await call(e, "POST", "/verify/ampr/start", { callsign: cs }, { cookie: me.cookie });
  return { me, s };
}
const check = (e: Env, cookie: string, cs = "OE8APR") =>
  call(e, "POST", "/verify/ampr/check", { callsign: cs }, { cookie });
const verified = async (e: Env, cs: string) =>
  (await call(e, "GET", `/verify/aprs/status?callsign=${cs}`)).data?.verified === true;
const row = (e: Env, cs: string) =>
  e.DB.prepare("SELECT * FROM callsign_verifications WHERE callsign=?").bind(cs).first<Record<string, unknown>>();

describe("starting an ampr.org DNS verification", () => {
  it("returns the code and the exact TXT record to publish", async () => {
    const e = env();
    const { s } = await started(e);
    expect(s.status).toBe(200);
    expect(s.data.code).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(s.data.name).toBe("_aprscaching.oe8apr.ampr.org");
    expect(s.data.value).toBe(`v=acs1; verify=${s.data.code}`);
    expect(s.data.record).toBe(`_aprscaching.oe8apr.ampr.org TXT "v=acs1; verify=${s.data.code}"`);
    expect(s.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("needs a session whose account holds the call", async () => {
    const e = env();
    await emailSignup(e, "owner@example.test", "OE8APR");
    const other = await emailSignup(e, "other@example.test", "DL1AAA");
    expect((await call(e, "POST", "/verify/ampr/start", { callsign: "OE8APR" })).status).toBe(401);
    expect((await call(e, "POST", "/verify/ampr/start", { callsign: "OE8APR" }, { cookie: other.cookie })).status).toBe(
      403,
    );
  });
});

describe("checking the published record", () => {
  it("verifies when the DNSSEC-validated TXT under ampr.org carries the current code", async () => {
    const e = env();
    const { me, s } = await started(e);
    const asked = stubDoh({ ad: true, txt: ["v=acs1; inst=oe.pub; key=" + "A".repeat(43), s.data.value] });
    const r = await check(e, me.cookie);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ verified: true, callsign: "OE8APR", method: "ampr_dns" });
    const q = new URL(asked[0]!).searchParams;
    expect([q.get("name"), q.get("type")]).toEqual(["_aprscaching.oe8apr.ampr.org", "TXT"]);
    expect(await verified(e, "OE8APR")).toBe(true);
    expect(await row(e, "OE8APR")).toMatchObject({
      status: "verified",
      method: "ampr_dns",
      verified_by: "oe8apr.ampr.org",
    });
    // the held call reads as verified through the one store
    const held = await e.DB.prepare(
      "SELECT ac.callsign, v.method FROM account_callsigns ac JOIN callsign_verifications v ON v.callsign = ac.callsign AND v.status = 'verified' WHERE ac.callsign='OE8APR'",
    ).first();
    expect(held).toEqual({ callsign: "OE8APR", method: "ampr_dns" });
    // the challenge is spent
    expect((await check(e, me.cookie)).status).toBe(409);
  });

  it("refuses an answer that is not DNSSEC-validated, whatever it carries", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDoh({ ad: false, txt: [s.data.value] });
    const r = await check(e, me.cookie);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/DNSSEC/);
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("refuses when the name does not exist, or the record carries another code", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDoh({ status: 3, ad: true });
    const nx = await check(e, me.cookie);
    expect(nx.status).toBe(422);
    expect(nx.data.error).toMatch(/_aprscaching\.oe8apr\.ampr\.org/);
    stubDoh({ ad: true, txt: ["v=acs1; verify=someoldcode0000000000"] });
    const wrong = await check(e, me.cookie);
    expect(wrong.status).toBe(422);
    expect(wrong.data.error).toMatch(/current code/);
    expect(await verified(e, "OE8APR")).toBe(false);
    // the record, once it carries the code, still verifies
    stubDoh({ ad: true, txt: [s.data.value] });
    expect((await check(e, me.cookie)).status).toBe(200);
  });

  it("a resolver failure is reported and verifies nothing", async () => {
    const e = env();
    const { me } = await started(e);
    globalThis.fetch = (async () => new Response("oops", { status: 502 })) as typeof fetch;
    const r = await check(e, me.cookie);
    expect(r.status).toBe(502);
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("needs an outstanding challenge of the same account, within its lifetime", async () => {
    const e = env();
    const me = await emailSignup(e, "owner@example.test", "OE8APR");
    stubDoh({ ad: true, txt: ["v=acs1; verify=x"] });
    expect((await check(e, me.cookie)).status).toBe(409);
    const s = await call(e, "POST", "/verify/ampr/start", { callsign: "OE8APR" }, { cookie: me.cookie });
    await e.DB.prepare("UPDATE callsign_challenges SET created_at = created_at - 3 * 86400").run();
    stubDoh({ ad: true, txt: [s.data.value] });
    expect((await check(e, me.cookie)).status).toBe(409);
    expect((await call(e, "POST", "/verify/ampr/check", { callsign: "OE8APR" })).status).toBe(401);
  });

  it("is rate limited per account", async () => {
    const e = env();
    const { me } = await started(e);
    stubDoh({ ad: true, txt: [] });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await check(e, me.cookie)).status);
    expect(codes).toContain(429);
    expect(codes.indexOf(429)).toBeGreaterThanOrEqual(5);
  });
});
