// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign control-verification through ampr.org DNS. ARDC delegates `<call>.ampr.org` only after
// reviewing the holder's licence, so a code the holder publishes under that name proves control of the
// call — provided the answer is authentic. A DNSSEC-validated answer (AD) from the validating resolver is
// enough on its own; without it, every configured independent resolver that answers must return the same
// TXT set carrying the code (at least two of them), and AMPR_REQUIRE_DNSSEC=1 turns that fallback off.
import { describe, it, expect, afterEach } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const DOH = "https://dns.example/dns-query";
const R1 = "https://r1.example/dns-query";
const R2 = "https://r2.example/resolve"; // the Google-style dialect: trailing dots, unquoted data
const R3 = "https://r3.example:5053/dns-query";
const RESOLVERS = [R1, R2, R3];
const env = (extra: Record<string, unknown> = {}) =>
  authEnv({ DOH_URL: DOH, AMPR_DNS_RESOLVERS: RESOLVERS.join(", "), ...extra });

interface Doh {
  status?: number;
  ad?: boolean;
  txt?: string[];
  /** Answer with a CNAME for the name first, then the TXT under the target name. */
  cname?: string;
  /** Answer only this name; any other is NXDOMAIN. */
  only?: string;
  /** Owner name of the TXT records, when not the queried name. */
  owner?: string;
}
type Reply = Doh | "timeout" | "http-error";

/** Stub every resolver: `answers` maps a resolver base URL to its reply; records every queried URL. */
function stubDns(answers: Record<string, Reply>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const base = url.split("?")[0]!;
    const a = answers[base];
    if (a === undefined) throw new Error(`unexpected fetch ${url}`);
    asked.push(url);
    if (a === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (a === "http-error") return new Response("oops", { status: 502 });
    const name = new URL(url).searchParams.get("name")!;
    if (a.only && a.only !== name)
      return new Response(JSON.stringify({ Status: 3, AD: false, Answer: [] }), {
        headers: { "content-type": "application/dns-json" },
      });
    const google = base === R2;
    const dn = (n: string) => (google ? `${n}.` : n);
    const data = (t: string) => (google ? t : `"${t}"`);
    const answer: { name: string; type: number; data: string }[] = [];
    let owner = a.owner ?? name;
    if (a.cname) {
      answer.push({ name: dn(name), type: 5, data: dn(a.cname) });
      owner = a.cname;
    }
    for (const t of a.txt ?? []) answer.push({ name: dn(owner), type: 16, data: data(t) });
    return new Response(JSON.stringify({ Status: a.status ?? 0, AD: a.ad ?? false, Answer: answer }), {
      headers: { "content-type": "application/dns-json" },
    });
  }) as typeof fetch;
  return asked;
}
/** Every resolver (the validating one included) gives the same reply. */
const everywhere = (a: Reply): Record<string, Reply> => Object.fromEntries([DOH, ...RESOLVERS].map((u) => [u, a]));

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
    expect(s.data.name).toBe("_aprscaching-verify.oe8apr.ampr.org");
    expect(s.data.value).toBe(`v=acs1; verify=${s.data.code}`);
    expect(s.data.record).toBe(`_aprscaching-verify.oe8apr.ampr.org TXT "v=acs1; verify=${s.data.code}"`);
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

describe("a DNSSEC-validated answer", () => {
  it("verifies on the validating resolver alone and records the proof as DNSSEC", async () => {
    const e = env();
    const { me, s } = await started(e);
    const asked = stubDns({ [DOH]: { ad: true, txt: ["v=acs1; inst=oe.pub; key=" + "A".repeat(43), s.data.value] } });
    const r = await check(e, me.cookie);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ verified: true, callsign: "OE8APR", method: "ampr_dns", proof: "dnssec" });
    expect(asked).toHaveLength(1);
    const q = new URL(asked[0]!).searchParams;
    expect([q.get("name"), q.get("type")]).toEqual(["_aprscaching-verify.oe8apr.ampr.org", "TXT"]);
    expect(await verified(e, "OE8APR")).toBe(true);
    expect(await row(e, "OE8APR")).toMatchObject({
      status: "verified",
      method: "ampr_dns",
      verified_by: "oe8apr.ampr.org",
      note: "dnssec",
    });
    // the held call reads as verified through the one store
    const held = await e.DB.prepare(
      "SELECT ac.callsign, v.method FROM account_callsigns ac JOIN callsign_verifications v ON v.callsign = ac.callsign AND v.status = 'verified' WHERE ac.callsign='OE8APR'",
    ).first();
    expect(held).toEqual({ callsign: "OE8APR", method: "ampr_dns" });
    // the challenge is spent
    expect((await check(e, me.cookie)).status).toBe(409);
  });

  it("refuses a validated answer that carries another code, and verifies once it carries the current one", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns({ [DOH]: { ad: true, txt: ["v=acs1; verify=someoldcode0000000000"] } });
    const wrong = await check(e, me.cookie);
    expect(wrong.status).toBe(422);
    expect(wrong.data.error).toMatch(/current code/);
    expect(await verified(e, "OE8APR")).toBe(false);
    stubDns({ [DOH]: { ad: true, txt: [s.data.value] } });
    expect((await check(e, me.cookie)).status).toBe(200);
  });

  it("refuses an answer that goes through a CNAME, validated or not", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns({ [DOH]: { ad: true, cname: "proof.attacker.example", txt: [s.data.value] } });
    const r = await check(e, me.cookie);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/CNAME/);
    stubDns(everywhere({ cname: "proof.attacker.example", txt: [s.data.value] }));
    expect((await check(e, me.cookie)).status).toBe(422);
    expect(await verified(e, "OE8APR")).toBe(false);
  });
});

describe("independent resolvers agreeing, without DNSSEC", () => {
  it("verifies when every configured resolver returns the code, and records the proof as multi-resolver", async () => {
    const e = env();
    const { me, s } = await started(e);
    const asked = stubDns(everywhere({ ad: false, txt: [s.data.value] }));
    const r = await check(e, me.cookie);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ verified: true, method: "ampr_dns", proof: "3 resolvers" });
    for (const u of RESOLVERS) expect(asked.some((a) => a.startsWith(u))).toBe(true);
    expect(await row(e, "OE8APR")).toMatchObject({
      status: "verified",
      method: "ampr_dns",
      verified_by: "oe8apr.ampr.org",
      note: "3 resolvers: r1.example, r2.example, r3.example",
    });
  });

  it("refuses when one resolver returns a different TXT set", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns({
      ...everywhere({ txt: [s.data.value] }),
      [R3]: { txt: [s.data.value, "v=acs1; verify=someoneelse000000000"] },
    });
    const r = await check(e, me.cookie);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/resolvers disagree/);
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("refuses when one resolver answers with a DNS error", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns({ ...everywhere({ txt: [s.data.value] }), [R2]: { status: 2 } });
    expect((await check(e, me.cookie)).status).toBe(422);
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("refuses when only one resolver answered", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns({ ...everywhere({ txt: [s.data.value] }), [R2]: "timeout", [R3]: "http-error" });
    const r = await check(e, me.cookie);
    expect(r.status).toBe(502);
    expect(r.data.error).toMatch(/1 of 3/);
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("a resolver that times out does not block two that answered and agree", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns({ ...everywhere({ txt: [s.data.value] }), [R3]: "timeout" });
    const r = await check(e, me.cookie);
    expect(r.status).toBe(200);
    expect(await row(e, "OE8APR")).toMatchObject({ note: "2 resolvers: r1.example, r2.example" });
  });

  it("refuses TXT records under another owner name", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns(everywhere({ owner: "_aprscaching-verify.dl1aaa.ampr.org", txt: [s.data.value] }));
    expect((await check(e, me.cookie)).status).toBe(422);
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("with AMPR_REQUIRE_DNSSEC=1, refuses any answer that is not DNSSEC-validated and asks no other resolver", async () => {
    const e = env({ AMPR_REQUIRE_DNSSEC: "1" });
    const { me, s } = await started(e);
    const asked = stubDns(everywhere({ ad: false, txt: [s.data.value] }));
    const r = await check(e, me.cookie);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/DNSSEC/);
    expect(asked.every((a) => a.startsWith(DOH))).toBe(true);
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("uses Cloudflare, Google and Quad9 when no resolvers are configured", async () => {
    const e = authEnv({ DOH_URL: DOH });
    const { me, s } = await started(e);
    const defaults = [
      "https://cloudflare-dns.com/dns-query",
      "https://dns.google/resolve",
      "https://dns.quad9.net:5053/dns-query",
    ];
    const asked = stubDns({
      [DOH]: { txt: [s.data.value] },
      ...Object.fromEntries(defaults.map((u) => [u, { txt: [s.data.value] }])),
    });
    expect((await check(e, me.cookie)).status).toBe(200);
    for (const u of defaults) expect(asked.some((a) => a.startsWith(u))).toBe(true);
  });
});

describe("the record's own name", () => {
  it("a code at the federation identity's name does not count: it belongs at _aprscaching-verify", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns(everywhere({ only: "_aprscaching.oe8apr.ampr.org", ad: true, txt: [s.data.value] }));
    const r = await check(e, me.cookie);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/_aprscaching-verify\.oe8apr\.ampr\.org is not published yet/);
    expect(await verified(e, "OE8APR")).toBe(false);
    stubDns(everywhere({ only: "_aprscaching-verify.oe8apr.ampr.org", ad: true, txt: [s.data.value] }));
    expect((await check(e, me.cookie)).status).toBe(200);
  });
});

describe("checking before the record resolves", () => {
  it("says the name is not published yet, and does not burn an attempt", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns(everywhere({ status: 3 }));
    for (let i = 0; i < 6; i++) {
      const nx = await check(e, me.cookie);
      expect(nx.status).toBe(422);
      expect(nx.data.error).toMatch(/not published yet/);
      expect(nx.data.error).toMatch(/_aprscaching-verify\.oe8apr\.ampr\.org/);
    }
    // the challenge is still open after more checks than the attempts cap
    stubDns(everywhere({ txt: [s.data.value] }));
    expect((await check(e, me.cookie)).status).toBe(200);
  });

  it("a record some resolvers do not see yet is not published everywhere, and costs no attempt", async () => {
    const e = env();
    const { me, s } = await started(e);
    stubDns({ ...everywhere({ txt: [s.data.value] }), [R1]: { status: 3 } });
    for (let i = 0; i < 6; i++) {
      const r = await check(e, me.cookie);
      expect(r.status).toBe(422);
      expect(r.data.error).toMatch(/not published yet everywhere \(r1\.example/);
    }
    expect(await verified(e, "OE8APR")).toBe(false);
  });

  it("a resolver failure everywhere is reported and verifies nothing", async () => {
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
    stubDns(everywhere({ ad: true, txt: ["v=acs1; verify=x"] }));
    expect((await check(e, me.cookie)).status).toBe(409);
    const s = await call(e, "POST", "/verify/ampr/start", { callsign: "OE8APR" }, { cookie: me.cookie });
    await e.DB.prepare("UPDATE callsign_challenges SET created_at = created_at - 3 * 86400").run();
    stubDns(everywhere({ ad: true, txt: [s.data.value] }));
    expect((await check(e, me.cookie)).status).toBe(409);
    expect((await call(e, "POST", "/verify/ampr/check", { callsign: "OE8APR" })).status).toBe(401);
  });

  it("is rate limited per account", async () => {
    const e = env();
    const { me } = await started(e);
    stubDns(everywhere({ ad: true, txt: [] }));
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await check(e, me.cookie)).status);
    expect(codes).toContain(429);
    expect(codes.indexOf(429)).toBeGreaterThanOrEqual(5);
  });
});
