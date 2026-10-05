// SPDX-License-Identifier: AGPL-3.0-or-later
// The callsign identity: the records this instance publishes so others add it by callsign (on 44Net at
// aprscaching.<call>.ampr.org by default, under its own name, or without 44Net through web=), and the
// read-only, on-demand self-check of what those instances find. It only looks things up in DNS and builds
// its own descriptor in-process: no reachability probe, no peer rows and no trust state are ever written.
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  check44net,
  identityPlan,
  handleIdentity,
  type DnsLookup,
  type CheckLine,
  type IdentityContext,
} from "../src/fed44netcheck.js";
import type { DnsAnswer } from "../src/doh.js";
import type { Env } from "../src/env.js";

const KEY = "A".repeat(43);
const OLD_KEY = "B".repeat(43);
const OTHER_KEY = "C".repeat(43);
const HOST = "aprscaching.oe8apr.ampr.org";
const POCKET = "aprscaching-pocket.oe8apr.ampr.org";
const WEB = "https://oe.pub";

/** The context of an instance with `address` as its 44net endpoint (none for null). */
const ctx = (
  address: string | null = HOST,
  over: Record<string, unknown> = {},
  web: string | null = WEB,
): IdentityContext => ({
  desc: {
    instance: "oe.pub",
    publicKey: KEY,
    publicKeys: [{ x: KEY }, { x: OLD_KEY }],
    addresses: [{ transport: "https", address: WEB }, ...(address ? [{ transport: "44net", address }] : [])],
    ...over,
  },
  operatorCall: "OE8APR",
  web,
});

const ok = (data: string[], dnssec = false): DnsAnswer => ({ status: 0, dnssec, data });
const NX: DnsAnswer = { status: 3, dnssec: false, data: [] };

/** A fake resolver: `records["<type> <name>"]` answers, anything else is NXDOMAIN; an Error throws. */
function fakeDns(records: Record<string, DnsAnswer | Error>): DnsLookup & { asked: string[] } {
  const asked: string[] = [];
  const fn = async (name: string, type: "A" | "AAAA" | "TXT") => {
    asked.push(`${type} ${name}`);
    const r = records[`${type} ${name}`];
    if (r instanceof Error) throw r;
    return r ?? NX;
  };
  return Object.assign(fn, { asked });
}

const TXT_NAME = "_aprscaching.oe8apr.ampr.org";
const GOOD_TXT = `v=acs1; inst=oe.pub; key=${KEY}`;
const line = (lines: CheckLine[], id: CheckLine["id"]) => lines.find((l) => l.id === id);
const problems = (lines: CheckLine[]) => lines.filter((l) => l.status === "fail" || l.status === "warn");

describe("identityPlan — the records to publish", () => {
  it("on 44Net with a public https origin: the main TXT names both, the 44Net-only value is the alternative", () => {
    const p = identityPlan(ctx());
    expect(p.callsign).toBe("OE8APR");
    expect(p.host).toBe(HOST);
    expect(p.records.map((r) => [r.portal, r.type, r.value, r.name])).toEqual([
      ["aprscaching", "A", "<your 44.x address>", HOST],
      ["_aprscaching", "TXT", `${GOOD_TXT}; host=${HOST}; web=${WEB}`, TXT_NAME],
    ]);
    expect(p.records[0]!.placeholder).toBe(true);
    expect(p.alternative).toMatchObject({ portal: "_aprscaching", value: GOOD_TXT });
  });

  it("on 44Net only: the plain TXT, and no alternative", () => {
    const p = identityPlan(ctx(HOST, {}, null));
    expect(p.records.map((r) => [r.portal, r.type, r.value])).toEqual([
      ["aprscaching", "A", "<your 44.x address>"],
      ["_aprscaching", "TXT", GOOD_TXT],
    ]);
    expect(p.alternative).toBeNull();
  });

  it("a further instance under the call publishes under its own label", () => {
    const p = identityPlan(ctx(POCKET, {}, null));
    expect(p.records.map((r) => [r.portal, r.type, r.value])).toEqual([
      ["aprscaching-pocket", "A", "<your 44.x address>"],
      ["_aprscaching.aprscaching-pocket", "TXT", GOOD_TXT],
    ]);
    expect(p.alternative).toBeNull();
  });

  it("without 44Net: one TXT with web= and no A record", () => {
    const p = identityPlan(ctx(null));
    expect(p.host).toBeNull();
    expect(p.records.map((r) => [r.portal, r.type, r.value])).toEqual([
      ["_aprscaching", "TXT", `${GOOD_TXT}; web=${WEB}`],
    ]);
  });

  it("a base-name endpoint gets the default name's records", () => {
    expect(identityPlan(ctx("oe8apr.ampr.org")).records[0]!.name).toBe(HOST);
  });

  it("says what is missing: no callsign, no key, nowhere to connect", () => {
    expect(identityPlan({ ...ctx(null), operatorCall: null }).reason).toMatch(/ADMIN_CALLSIGNS/);
    expect(identityPlan(ctx(HOST, { publicKey: null })).reason).toMatch(/FED_PRIVATE_KEY/);
    expect(identityPlan(ctx(null, {}, null)).reason).toMatch(/nowhere/);
  });

  it("takes the base call of an operator call with an SSID", () => {
    expect(identityPlan({ ...ctx(null), operatorCall: "OE8APR-10" }).callsign).toBe("OE8APR");
  });
});

describe("check44net — the TXT binding", () => {
  it("passes when inst and key match this instance", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([GOOD_TXT]), [`A ${HOST}`]: ok(["44.143.1.2"]) });
    const r = (await check44net(ctx(), dns))!;
    expect(r.callsign).toBe("OE8APR");
    expect(r.host).toBe(HOST);
    expect(line(r.lines, "txt")?.status).toBe("pass");
    expect(line(r.lines, "target")).toMatchObject({ status: "pass", detail: `44Net ${HOST}` });
    expect(problems(r.lines)).toEqual([]);
  });

  it("fails on a key that is not this instance's, showing the exact value and Portal name", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=oe.pub; key=${OTHER_KEY}`]),
      [`A ${HOST}`]: ok(["44.143.1.2"]),
    });
    const txt = line((await check44net(ctx(HOST, {}, null), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.fix).toBe(
      `Publish TXT ${TXT_NAME} "${GOOD_TXT}" in the 44Net Portal (changes there publish within about an hour); the Portal name is _aprscaching.`,
    );
  });

  it("warns on an older key the descriptor still lists as active", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=oe.pub; key=${OLD_KEY}`]),
      [`A ${HOST}`]: ok(["44.143.1.2"]),
    });
    const txt = line((await check44net(ctx(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("warn");
    expect(txt.fix).toContain(`key=${KEY}`);
  });

  it("fails on a different inst", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=other.example; key=${KEY}`]) });
    const txt = line((await check44net(ctx(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.detail).toContain("other.example");
  });

  it("a verify= record at the identity name does not count, and the check names where it belongs", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok(["v=acs1; verify=abc123"]) });
    const txt = line((await check44net(ctx(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.detail).toContain("_aprscaching-verify.oe8apr.ampr.org");
  });

  it("fails on a missing TXT, and without a federation signing key", async () => {
    expect(line((await check44net(ctx(), fakeDns({})))!.lines, "txt")).toMatchObject({ status: "fail" });
    const noKey = line((await check44net(ctx(HOST, { publicKey: null, publicKeys: [] }), fakeDns({})))!.lines, "txt")!;
    expect(noKey.status).toBe("fail");
    expect(noKey.fix).toMatch(/FED_PRIVATE_KEY/);
  });
});

describe("check44net — the 44Net endpoint and its A record", () => {
  it("fails on the base name, with the default name as the fix, and looks nothing up", async () => {
    const dns = fakeDns({});
    const r = (await check44net(ctx("oe8apr.ampr.org"), dns))!;
    expect(line(r.lines, "endpoint")).toMatchObject({ status: "fail", detail: expect.stringMatching(/base name/) });
    expect(line(r.lines, "endpoint")!.fix).toContain(`--name ${HOST}`);
    expect(dns.asked).toEqual([]);
  });

  it("fails on a missing A record and names the record and its Portal name", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([GOOD_TXT]) });
    const a = line((await check44net(ctx(), dns))!.lines, "a")!;
    expect(a.status).toBe("fail");
    expect(a.fix).toContain(`A ${HOST}`);
    expect(a.fix).toContain("the Portal name is aprscaching.");
  });

  it("warns on an address outside 44.0.0.0/8", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([GOOD_TXT]), [`A ${HOST}`]: ok(["203.0.113.7"]) });
    const a = line((await check44net(ctx(), dns))!.lines, "a")!;
    expect(a.status).toBe("warn");
    expect(a.detail).toContain("203.0.113.7");
  });

  it("fails when the record sends peers to another 44Net host than the endpoint", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`${GOOD_TXT}; host=node.oe8apr.ampr.org`]),
      "A node.oe8apr.ampr.org": ok(["44.143.9.9"]),
    });
    const t = line((await check44net(ctx(), dns))!.lines, "target")!;
    expect(t.status).toBe("fail");
    expect(t.detail).toContain("node.oe8apr.ampr.org");
  });

  it("an instance under its own name reads its own record first", async () => {
    const dns = fakeDns({ [`TXT _aprscaching.${POCKET}`]: ok([GOOD_TXT], true), [`A ${POCKET}`]: ok(["44.143.9.9"]) });
    const r = (await check44net(ctx(POCKET), dns))!;
    expect(dns.asked.indexOf(`TXT _aprscaching.${POCKET}`)).toBeLessThan(dns.asked.indexOf(`TXT ${TXT_NAME}`));
    expect(line(r.lines, "txt")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining(`_aprscaching.${POCKET}`),
    });
    expect(line(r.lines, "dnssec")?.detail).toMatch(/DNSSEC-validated/);
    expect(problems(r.lines)).toEqual([]);
  });

  it("an instance under its own name passes on the callsign's record when that one sends peers to it", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`${GOOD_TXT}; host=${POCKET}`]),
      [`A ${POCKET}`]: ok(["44.1.2.3"]),
    });
    const r = (await check44net(ctx(POCKET), dns))!;
    expect(line(r.lines, "txt")?.status).toBe("pass");
  });

  it("warns when the callsign's record sends peers to this host with another binding", async () => {
    const dns = fakeDns({
      [`TXT _aprscaching.${POCKET}`]: ok([GOOD_TXT]),
      [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=oe.old; key=${OTHER_KEY}; host=${POCKET}`]),
      [`A ${POCKET}`]: ok(["44.143.9.9"]),
    });
    const r = (await check44net(ctx(POCKET), dns))!;
    expect(line(r.lines, "txt")?.status).toBe("pass");
    expect(line(r.lines, "callsign")).toMatchObject({ status: "warn", fix: expect.stringMatching(/^Make .*\.$/) });
  });

  it("the home station's record for the callsign is information for the Pocket", async () => {
    const dns = fakeDns({
      [`TXT _aprscaching.${POCKET}`]: ok([GOOD_TXT]),
      [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=oe.home; key=${OTHER_KEY}`]),
      [`A ${POCKET}`]: ok(["44.143.9.9"]),
    });
    const r = (await check44net(ctx(POCKET), dns))!;
    expect(line(r.lines, "callsign")).toMatchObject({ status: "info", detail: expect.stringContaining(HOST) });
    expect(problems(r.lines)).toEqual([]);
  });
});

describe("check44net — without 44Net", () => {
  it("passes on a web= record naming this instance's https origin, with no A lookup", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([`${GOOD_TXT}; web=${WEB}`]) });
    const r = (await check44net(ctx(null), dns))!;
    expect(line(r.lines, "endpoint")?.status).toBe("info");
    expect(line(r.lines, "txt")?.status).toBe("pass");
    expect(line(r.lines, "target")).toMatchObject({ status: "pass", detail: `https ${WEB}` });
    expect(dns.asked.some((q) => q.startsWith("A "))).toBe(false);
    expect(problems(r.lines)).toEqual([]);
  });

  it("nothing published is information, with the value to publish", async () => {
    const r = (await check44net(ctx(null), fakeDns({})))!;
    expect(line(r.lines, "txt")).toMatchObject({ status: "info" });
    expect(line(r.lines, "txt")!.fix).toContain(`"${GOOD_TXT}; web=${WEB}"`);
    expect(problems(r.lines)).toEqual([]);
  });

  it("fails on a web= that is not this instance, and on a record that sends peers to 44Net", async () => {
    let r = (await check44net(
      ctx(null),
      fakeDns({ [`TXT ${TXT_NAME}`]: ok([`${GOOD_TXT}; web=https://other.example`]) }),
    ))!;
    expect(line(r.lines, "target")).toMatchObject({ status: "fail", detail: expect.stringContaining("other.example") });
    r = (await check44net(ctx(null), fakeDns({ [`TXT ${TXT_NAME}`]: ok([GOOD_TXT]) })))!;
    expect(line(r.lines, "target")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/no 44net endpoint/),
    });
  });

  it("is not applicable without a callsign, or with nowhere to connect", async () => {
    expect(await check44net({ ...ctx(null), operatorCall: null }, fakeDns({}))).toBeNull();
    expect(await check44net(ctx(null, {}, null), fakeDns({}))).toBeNull();
  });
});

describe("check44net — DNSSEC, AAAA and failures", () => {
  it("reports the DNSSEC AD flag and an AAAA record as information", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([GOOD_TXT], true),
      [`A ${HOST}`]: ok(["44.143.1.2"]),
      [`AAAA ${HOST}`]: ok(["2001:db8::1"]),
    });
    const r = (await check44net(ctx(), dns))!;
    expect(line(r.lines, "dnssec")).toMatchObject({ status: "info", detail: expect.stringMatching(/validated/) });
    expect(line(r.lines, "aaaa")).toMatchObject({ status: "info", detail: expect.stringContaining("2001:db8::1") });
  });

  it("a DoH failure warns, never throws", async () => {
    const down = new Error("DNS resolver 502");
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: down, [`A ${HOST}`]: down, [`AAAA ${HOST}`]: down });
    const r = (await check44net(ctx(), dns))!;
    expect(line(r.lines, "txt")?.status).toBe("warn");
    expect(line(r.lines, "a")?.status).toBe("warn");
    expect(r.lines.every((l) => l.status !== "fail")).toBe(true);
    expect(line(r.lines, "txt")!.fix).toMatch(/DOH_URL/);
  });

  it("an endpoint outside ampr.org fails with its fix", async () => {
    const r = (await check44net(ctx("node.hamnet.example"), fakeDns({})))!;
    expect(line(r.lines, "endpoint")?.status).toBe("fail");
  });

  it("every non-passing line carries a one-sentence fix", async () => {
    const r = (await check44net(ctx(), fakeDns({ [`TXT ${TXT_NAME}`]: ok(["test"]) })))!;
    for (const l of problems(r.lines)) expect(l.fix).toMatch(/^[A-Z].*\.$/);
  });
});

// ---- the sysop endpoint: an in-process descriptor and DoH lookups, nothing else

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let publicX: string;
let keyEnvVal: string;
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicX = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  keyEnvVal = btoa(JSON.stringify({ pkcs8: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), pub: publicX }));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch: DoH answers by `type name`; records every URL asked for. */
function stubDoh(answers: Record<string, unknown>, fail = false) {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    fetched.push(url.toString());
    if (fail) return { ok: false, status: 502, json: async () => ({}) } as Response;
    const key = `${url.searchParams.get("type")} ${url.searchParams.get("name")}`;
    return { ok: true, status: 200, json: async () => answers[key] ?? { Status: 3 } } as Response;
  }) as typeof fetch;
  return fetched;
}

/** A DB that records every statement and answers nothing: the check must never touch it. */
function spyDb() {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare(s: string) {
        sql.push(s);
        throw new Error("the identity self-check must not touch the database");
      },
    },
  };
}

const checkEnv = (db: unknown, endpoints: string, over: Record<string, unknown> = {}): Env =>
  ({
    DB: db,
    INSTANCE: "oe.pub",
    APP_URL: "https://oe.pub",
    ADMIN_CALLSIGNS: "OE8APR",
    FED_PRIVATE_KEY: keyEnvVal,
    FED_ENDPOINTS: endpoints,
    OPERATOR_SECRET: "sysop-bypass-secret",
    DOH_URL: "https://dns.example/dns-query",
    ...over,
  }) as unknown as Env;
const EP44 = `[{"transport":"44net","address":"${HOST}","priority":10}]`;
const get = (query = "", secret = "sysop-bypass-secret") =>
  new Request(`http://gw/api/admin/federation/identity${query}`, { headers: { "x-operator-secret": secret } });

describe("GET /api/admin/federation/identity", () => {
  it("is sysop-gated", async () => {
    const { db } = spyDb();
    expect((await handleIdentity(get("", "wrong"), checkEnv(db, EP44))).status).toBe(401);
  });

  it("returns the records computed from INSTANCE, the key, the call, the endpoint and APP_URL, with no lookups", async () => {
    const { db } = spyDb();
    const fetched = stubDoh({});
    const body = await (await handleIdentity(get(), checkEnv(db, EP44))).json();
    expect(body).toMatchObject({ applicable: true, callsign: "OE8APR", host: HOST, web: "https://oe.pub" });
    expect(
      body.records.map((r: { portal: string; type: string; value: string }) => [r.portal, r.type, r.value]),
    ).toEqual([
      ["aprscaching", "A", "<your 44.x address>"],
      ["_aprscaching", "TXT", `v=acs1; inst=oe.pub; key=${publicX}; host=${HOST}; web=https://oe.pub`],
    ]);
    expect(body.alternative.value).toBe(`v=acs1; inst=oe.pub; key=${publicX}`);
    expect(body.lines).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  it("a LAN or loopback APP_URL is no https origin for peers: 44Net only", async () => {
    const { db } = spyDb();
    for (const app of ["https://localhost:8443", "https://192.168.1.10", "https://aprs.lan"]) {
      const body = await (await handleIdentity(get(), checkEnv(db, EP44, { APP_URL: app }))).json();
      expect(body.web).toBeNull();
      expect(body.records[1].value).toBe(`v=acs1; inst=oe.pub; key=${publicX}`);
    }
  });

  it("without 44Net returns the web= record", async () => {
    const { db } = spyDb();
    const body = await (await handleIdentity(get(), checkEnv(db, "[]"))).json();
    expect(body.records).toEqual([
      expect.objectContaining({
        portal: "_aprscaching",
        type: "TXT",
        value: `v=acs1; inst=oe.pub; key=${publicX}; web=https://oe.pub`,
      }),
    ]);
  });

  it("check=1 runs the check against the in-process descriptor's key, over DoH only, and writes nothing", async () => {
    const { db, sql } = spyDb();
    const fetched = stubDoh({
      [`TXT ${TXT_NAME}`]: {
        Status: 0,
        AD: false,
        Answer: [{ name: TXT_NAME, type: 16, data: `"v=acs1; inst=oe.pub; key=${publicX}"` }],
      },
      [`A ${HOST}`]: { Status: 0, Answer: [{ name: HOST, type: 1, data: "44.143.1.2" }] },
    });
    const res = await handleIdentity(get("?check=1"), checkEnv(db, EP44));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applicable: boolean; lines: CheckLine[] };
    expect(body.applicable).toBe(true);
    expect(line(body.lines, "txt")?.status).toBe("pass");
    expect(line(body.lines, "a")?.status).toBe("pass");
    expect(line(body.lines, "target")?.status).toBe("pass");
    expect(sql).toEqual([]); // no peer rows, no trust state
    expect(fetched.every((u) => new URL(u).origin === "https://dns.example")).toBe(true); // no self-fetch, no probe
  });

  it("a resolver outage answers 200 with warnings", async () => {
    const { db } = spyDb();
    stubDoh({}, true);
    const body = (await (await handleIdentity(get("?check=1"), checkEnv(db, EP44))).json()) as { lines: CheckLine[] };
    expect(line(body.lines, "txt")?.status).toBe("warn");
  });

  it("is not applicable with no callsign, and says why", async () => {
    const { db } = spyDb();
    const fetched = stubDoh({});
    const body = await (await handleIdentity(get("?check=1"), checkEnv(db, "[]", { ADMIN_CALLSIGNS: "" }))).json();
    expect(body).toMatchObject({ applicable: false, reason: expect.stringMatching(/ADMIN_CALLSIGNS/) });
    expect(fetched).toEqual([]);
  });
});
