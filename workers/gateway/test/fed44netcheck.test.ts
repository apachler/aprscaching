// SPDX-License-Identifier: AGPL-3.0-or-later
// The 44Net self-check: a read-only, on-demand look at what other instances see when they add this one by
// callsign — the A record of the host they contact, the `_aprscaching` TXT binding, the descriptor's 44net
// endpoint, and the DNSSEC and AAAA facts. It only looks things up in DNS and builds its own descriptor
// in-process: no reachability probe, no peer rows and no trust state are ever written.
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { check44net, handleFed44netCheck, type DnsLookup, type CheckLine } from "../src/fed44netcheck.js";
import type { DnsAnswer } from "../src/doh.js";
import type { Env } from "../src/env.js";

const KEY = "A".repeat(43);
const OLD_KEY = "B".repeat(43);
const OTHER_KEY = "C".repeat(43);

const descriptor = (address = "oe8apr.ampr.org", over: Record<string, unknown> = {}) => ({
  instance: "oe.pub",
  publicKey: KEY,
  publicKeys: [{ x: KEY }, { x: OLD_KEY }],
  addresses: [
    { transport: "https", address: "https://oe.pub", priority: 0 },
    { transport: "44net", address, priority: 10 },
  ],
  ...over,
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

describe("check44net — the TXT binding", () => {
  it("passes when inst and key match this instance", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([GOOD_TXT]), "A oe8apr.ampr.org": ok(["44.143.1.2"]) });
    const r = (await check44net(descriptor(), dns))!;
    expect(r.callsign).toBe("OE8APR");
    expect(r.host).toBe("oe8apr.ampr.org");
    expect(line(r.lines, "txt")?.status).toBe("pass");
    expect(r.lines.filter((l) => l.status === "fail" || l.status === "warn")).toEqual([]);
  });

  it("fails on a key that is not this instance's, showing the exact value to publish", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=oe.pub; key=${OTHER_KEY}`]),
      "A oe8apr.ampr.org": ok(["44.143.1.2"]),
    });
    const txt = line((await check44net(descriptor(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.fix).toContain(`"v=acs1; inst=oe.pub; key=${KEY}"`);
    expect(txt.fix).toContain(TXT_NAME);
  });

  it("warns on an older key the descriptor still lists as active", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=oe.pub; key=${OLD_KEY}`]),
      "A oe8apr.ampr.org": ok(["44.143.1.2"]),
    });
    const txt = line((await check44net(descriptor(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("warn");
    expect(txt.fix).toContain(`key=${KEY}`);
  });

  it("fails on a different inst", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`v=acs1; inst=other.example; key=${KEY}`]),
      "A oe8apr.ampr.org": ok(["44.143.1.2"]),
    });
    const txt = line((await check44net(descriptor(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.detail).toContain("other.example");
  });

  it('fails on a placeholder ("test") with the exact value to publish', async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok(["test"]), "A oe8apr.ampr.org": ok(["44.143.1.2"]) });
    const txt = line((await check44net(descriptor(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.fix).toBe(
      `Publish TXT ${TXT_NAME} "v=acs1; inst=oe.pub; key=${KEY}" in the 44Net Portal (changes there publish within about an hour).`,
    );
  });

  it("does not count a callsign-verification record, and says so", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok(["v=acs1; verify=abc123"]), "A oe8apr.ampr.org": ok(["44.1.1.1"]) });
    const txt = line((await check44net(descriptor(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.detail).toMatch(/verify=/);
  });

  it("fails on a missing TXT", async () => {
    const dns = fakeDns({ "A oe8apr.ampr.org": ok(["44.143.1.2"]) });
    const txt = line((await check44net(descriptor(), dns))!.lines, "txt")!;
    expect(txt.status).toBe("fail");
    expect(txt.fix).toContain(`key=${KEY}`);
  });

  it("fails without a federation signing key", async () => {
    const dns = fakeDns({ "A oe8apr.ampr.org": ok(["44.143.1.2"]) });
    const txt = line(
      (await check44net(descriptor("oe8apr.ampr.org", { publicKey: null, publicKeys: [] }), dns))!.lines,
      "txt",
    )!;
    expect(txt.status).toBe("fail");
    expect(txt.fix).toMatch(/FED_PRIVATE_KEY/);
  });
});

describe("check44net — the effective host and its A record", () => {
  it("fails on a missing A record and names the record to add", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([GOOD_TXT]) });
    const a = line((await check44net(descriptor(), dns))!.lines, "a")!;
    expect(a.status).toBe("fail");
    expect(a.fix).toContain("A oe8apr.ampr.org");
  });

  it("follows host= when the TXT names one: the A lookup, the host and the value to publish", async () => {
    const sub = "aprscaching.oe8apr.ampr.org";
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`${GOOD_TXT}; host=${sub}`]),
      [`A ${sub}`]: ok(["44.143.9.9"]),
    });
    const r = (await check44net(descriptor(sub), dns))!;
    expect(r.host).toBe(sub);
    expect(dns.asked).toContain(`A ${sub}`);
    expect(dns.asked).not.toContain("A oe8apr.ampr.org");
    expect(line(r.lines, "a")?.status).toBe("pass");
    expect(line(r.lines, "txt")?.status).toBe("pass");
    expect(line(r.lines, "descriptor")?.status).toBe("pass");
  });

  it("the value to publish carries host= when the endpoint is a subdomain", async () => {
    const sub = "aprscaching.oe8apr.ampr.org";
    const dns = fakeDns({ [`A ${sub}`]: ok(["44.143.9.9"]) });
    const r = (await check44net(descriptor(sub), dns))!;
    expect(r.host).toBe(sub); // no usable TXT: the host this instance publishes is checked
    expect(line(r.lines, "txt")!.fix).toContain(`"v=acs1; inst=oe.pub; key=${KEY}; host=${sub}"`);
    expect(dns.asked).toContain(`A ${sub}`);
  });

  it("an endpoint under the zone, an A only on it, and a placeholder TXT: host= in the fix, A passes", async () => {
    const sub = "aprscaching.oe8apr.ampr.org";
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok(["test"]), [`A ${sub}`]: ok(["44.27.138.114"]) });
    const r = (await check44net(descriptor(sub), dns))!;
    expect(line(r.lines, "a")?.status).toBe("pass");
    expect(dns.asked).not.toContain("A oe8apr.ampr.org");
    expect(line(r.lines, "txt")).toMatchObject({ status: "fail" });
    expect(line(r.lines, "txt")!.fix).toBe(
      `Publish TXT ${TXT_NAME} "v=acs1; inst=oe.pub; key=${KEY}; host=${sub}" in the 44Net Portal (changes there publish within about an hour).`,
    );
  });

  it("the callsign comes from a subdomain endpoint too", async () => {
    const r = (await check44net(descriptor("node.oe8apr.ampr.org"), fakeDns({})))!;
    expect(r.callsign).toBe("OE8APR");
  });

  it("warns on an address outside 44.0.0.0/8", async () => {
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: ok([GOOD_TXT]), "A oe8apr.ampr.org": ok(["203.0.113.7"]) });
    const a = line((await check44net(descriptor(), dns))!.lines, "a")!;
    expect(a.status).toBe("warn");
    expect(a.detail).toContain("203.0.113.7");
  });
});

describe("check44net — descriptor, DNSSEC, AAAA and failures", () => {
  it("fails when the descriptor lists a different 44net endpoint than the TXT names", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([`${GOOD_TXT}; host=aprscaching.oe8apr.ampr.org`]),
      "A aprscaching.oe8apr.ampr.org": ok(["44.143.9.9"]),
    });
    const d = line((await check44net(descriptor("oe8apr.ampr.org"), dns))!.lines, "descriptor")!;
    expect(d.status).toBe("fail");
    expect(d.detail).toContain("aprscaching.oe8apr.ampr.org");
  });

  it("reports the DNSSEC AD flag and an AAAA record as information", async () => {
    const dns = fakeDns({
      [`TXT ${TXT_NAME}`]: ok([GOOD_TXT], true),
      "A oe8apr.ampr.org": ok(["44.143.1.2"]),
      "AAAA oe8apr.ampr.org": ok(["2001:db8::1"]),
    });
    const r = (await check44net(descriptor(), dns))!;
    expect(line(r.lines, "dnssec")).toMatchObject({ status: "info" });
    expect(line(r.lines, "dnssec")!.detail).toMatch(/validated/);
    expect(line(r.lines, "aaaa")).toMatchObject({ status: "info" });
    expect(line(r.lines, "aaaa")!.detail).toContain("2001:db8::1");
    expect(line(r.lines, "aaaa")!.detail).toMatch(/IPv4 A record/);
  });

  it("a DoH failure warns, never throws", async () => {
    const down = new Error("DNS resolver 502");
    const dns = fakeDns({ [`TXT ${TXT_NAME}`]: down, "A oe8apr.ampr.org": down, "AAAA oe8apr.ampr.org": down });
    const r = (await check44net(descriptor(), dns))!;
    expect(line(r.lines, "txt")?.status).toBe("warn");
    expect(line(r.lines, "a")?.status).toBe("warn");
    expect(r.lines.every((l) => l.status !== "fail")).toBe(true);
    expect(line(r.lines, "txt")!.fix).toMatch(/DOH_URL/);
  });

  it("an endpoint outside ampr.org fails with its fix and looks nothing up", async () => {
    const dns = fakeDns({});
    const r = (await check44net(descriptor("node.hamnet.example"), dns))!;
    expect(line(r.lines, "endpoint")?.status).toBe("fail");
    expect(dns.asked).toEqual([]);
  });

  it("is not applicable without a 44net endpoint", async () => {
    const d = descriptor();
    d.addresses = d.addresses.filter((a) => a.transport !== "44net");
    expect(await check44net(d, fakeDns({}))).toBeNull();
  });

  it("every non-passing line carries a one-sentence fix", async () => {
    const r = (await check44net(descriptor(), fakeDns({ [`TXT ${TXT_NAME}`]: ok(["test"]) })))!;
    for (const l of r.lines.filter((x) => x.status === "fail" || x.status === "warn"))
      expect(l.fix).toMatch(/^[A-Z].*\.$/);
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
        throw new Error("the 44Net self-check must not touch the database");
      },
    },
  };
}

const checkEnv = (db: unknown, endpoints: string): Env =>
  ({
    DB: db,
    INSTANCE: "oe.pub",
    FED_PRIVATE_KEY: keyEnvVal,
    FED_ENDPOINTS: endpoints,
    OPERATOR_SECRET: "sysop-bypass-secret",
    DOH_URL: "https://dns.example/dns-query",
  }) as unknown as Env;
const EP44 = '[{"transport":"44net","address":"oe8apr.ampr.org","priority":10}]';
const get = (secret = "sysop-bypass-secret") =>
  new Request("http://gw/api/admin/setup/44net", { headers: { "x-operator-secret": secret } });

describe("GET /api/admin/setup/44net", () => {
  it("is sysop-gated", async () => {
    const { db } = spyDb();
    expect((await handleFed44netCheck(get("wrong"), checkEnv(db, EP44))).status).toBe(401);
  });

  it("checks against the in-process descriptor's key, over DoH only, and writes nothing (trust guard)", async () => {
    const { db, sql } = spyDb();
    const fetched = stubDoh({
      [`TXT ${TXT_NAME}`]: {
        Status: 0,
        AD: false,
        Answer: [{ name: TXT_NAME, type: 16, data: `"v=acs1; inst=oe.pub; key=${publicX}"` }],
      },
      "A oe8apr.ampr.org": { Status: 0, Answer: [{ name: "oe8apr.ampr.org", type: 1, data: "44.143.1.2" }] },
    });
    const res = await handleFed44netCheck(get(), checkEnv(db, EP44));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applicable: boolean; lines: CheckLine[] };
    expect(body.applicable).toBe(true);
    expect(line(body.lines, "txt")?.status).toBe("pass");
    expect(line(body.lines, "a")?.status).toBe("pass");
    expect(line(body.lines, "descriptor")?.status).toBe("pass");
    expect(sql).toEqual([]); // no peer rows, no trust state
    expect(
      fetched.every((u) => {
        const url = new URL(u);
        return url.origin === "https://dns.example" && url.pathname === "/dns-query";
      }),
    ).toBe(true); // no self-fetch, no probe
  });

  it("a resolver outage answers 200 with warnings", async () => {
    const { db } = spyDb();
    stubDoh({}, true);
    const res = await handleFed44netCheck(get(), checkEnv(db, EP44));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: CheckLine[] };
    expect(line(body.lines, "txt")?.status).toBe("warn");
  });

  it("reports not applicable without a 44net endpoint", async () => {
    const { db } = spyDb();
    const fetched = stubDoh({});
    const res = await handleFed44netCheck(get(), checkEnv(db, "[]"));
    expect(await res.json()).toEqual({ applicable: false });
    expect(fetched).toEqual([]);
  });
});
