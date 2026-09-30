// SPDX-License-Identifier: AGPL-3.0-or-later
// 44net onboarding: the ARDC-delegated <call>.ampr.org name + a DNS-advertised key bind a peer's
// identity. DNSSEC-validated bindings admit automatically; without DNSSEC the operator must confirm
// (TOFU). A descriptor that CONTRADICTS the DNS binding is refused outright, and admission attests
// identity only — the peer lands `unvetted`, and a `blocked` peer is never resurrected by re-adding.
import { describe, it, expect, afterEach } from "vitest";
import { parse44netTxt, resolve44net, handleFed44netAdd } from "../src/fed44net.js";
import type { Env } from "../src/env.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY = "A".repeat(43); // b64url-shaped 32-byte Ed25519 key
const TXT = `v=acs1; inst=oe.pub; key=${KEY}`;

/** Every URL the stubbed network was asked for. */
let fetched: string[] = [];

/** Stub fetch: DoH queries answer with `doh`; descriptor fetches answer with `wk` (or fail). */
function stubNet(doh: unknown, wk?: unknown) {
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes("dns-query") || url.includes("dns.example"))
      return { ok: true, status: 200, json: async () => doh } as Response;
    if (url.includes("/.well-known/aprscaching")) {
      if (wk === undefined) throw new Error("unreachable");
      return { ok: true, status: 200, json: async () => wk } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const dohAnswer = (opts: { ad: boolean; txt?: string; status?: number }) => ({
  Status: opts.status ?? 0,
  AD: opts.ad,
  Answer: opts.txt !== undefined ? [{ name: "_aprscaching.oe8apr.ampr.org", type: 16, data: `"${opts.txt}"` }] : [],
});

/** Mock DB capturing fed_peers inserts; sysop check is bypassed with the ingest secret. */
function peersDb() {
  const rows: unknown[][] = [];
  return {
    rows,
    db: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          async run() {
            if (sql.includes("INSERT INTO fed_peers")) rows.push(args);
            return {};
          },
          async first() {
            return null;
          },
        }),
      }),
    },
  };
}

const envWith = (db: unknown): Env =>
  ({ DB: db, OPERATOR_SECRET: "sysop-bypass-secret", DOH_URL: "https://dns.example/dns-query" }) as unknown as Env;

const post = (body: unknown) =>
  new Request("http://gw/federation/peers/44net", {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-secret": "sysop-bypass-secret" },
    body: JSON.stringify(body),
  });

describe("parse44netTxt", () => {
  it("parses the v=acs1 binding and rejects everything else", () => {
    expect(parse44netTxt(TXT, "OE8APR")).toEqual({ instance: "oe.pub", publicKey: KEY, host: "oe8apr.ampr.org" });
    expect(parse44netTxt("v=spf1 include:_spf.example.com ~all", "OE8APR")).toBeNull();
    expect(parse44netTxt("v=acs1; inst=oe.pub", "OE8APR")).toBeNull(); // no key
    expect(parse44netTxt(`v=acs1; inst=oe.pub; key=short`, "OE8APR")).toBeNull(); // not a 32-byte key shape
  });
});

// host= moves where the peer is contacted, never out of the callsign's own ARDC zone: a TXT that points
// federation traffic at a third party is refused as a whole.
describe("parse44netTxt — host=", () => {
  const withHost = (h: string) => parse44netTxt(`${TXT}; host=${h}`, "OE8APR");
  it("without host= the peer is <call>.ampr.org", () => {
    expect(parse44netTxt(TXT, "oe8apr")?.host).toBe("oe8apr.ampr.org");
  });
  it("accepts the zone itself and any subdomain of it", () => {
    expect(withHost("oe8apr.ampr.org")?.host).toBe("oe8apr.ampr.org");
    expect(withHost("aprscaching.oe8apr.ampr.org")?.host).toBe("aprscaching.oe8apr.ampr.org");
    expect(withHost("a.b-c.oe8apr.ampr.org")?.host).toBe("a.b-c.oe8apr.ampr.org");
  });
  it("normalises uppercase", () => {
    expect(withHost("APRSCACHING.OE8APR.AMPR.ORG")?.host).toBe("aprscaching.oe8apr.ampr.org");
  });
  it("rejects the whole record for a host outside the callsign's zone", () => {
    expect(withHost("example.com")).toBeNull();
    expect(withHost("oe8xyz.ampr.org")).toBeNull(); // another call's zone
    expect(withHost("aprscaching.oe8xyz.ampr.org")).toBeNull();
    expect(withHost("xoe8apr.ampr.org")).toBeNull(); // a suffix match that is not a label boundary
    expect(withHost("evil.com.oe8apr.ampr.org.attacker.net")).toBeNull();
    expect(withHost("ampr.org")).toBeNull();
  });
  it("rejects a trailing dot and invalid hostnames", () => {
    expect(withHost("oe8apr.ampr.org.")).toBeNull();
    expect(withHost("")).toBeNull();
    expect(withHost("-bad.oe8apr.ampr.org")).toBeNull();
    expect(withHost("bad-.oe8apr.ampr.org")).toBeNull();
    expect(withHost("a..oe8apr.ampr.org")).toBeNull();
    expect(withHost("under_score.oe8apr.ampr.org")).toBeNull();
    expect(withHost("http://oe8apr.ampr.org")).toBeNull();
    expect(withHost("oe8apr.ampr.org:8080")).toBeNull();
    expect(withHost(`${"a".repeat(64)}.oe8apr.ampr.org`)).toBeNull(); // label over 63
    const long = `${Array.from({ length: 5 }, () => "a".repeat(50)).join(".")}.oe8apr.ampr.org`; // > 253
    expect(long.length).toBeGreaterThan(253);
    expect(withHost(long)).toBeNull();
  });
});

describe("resolve44net", () => {
  it("resolves the TXT with the DNSSEC AD flag", async () => {
    stubNet(dohAnswer({ ad: true, txt: TXT }));
    const r = await resolve44net(envWith({}), "oe8apr");
    expect(r).toEqual({
      callsign: "OE8APR",
      host: "oe8apr.ampr.org",
      instance: "oe.pub",
      publicKey: KEY,
      dnssec: true,
    });
  });
  it("follows a host= in the zone, and skips a record whose host= leaves it", async () => {
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=aprscaching.oe8apr.ampr.org` }));
    expect((await resolve44net(envWith({}), "oe8apr")).host).toBe("aprscaching.oe8apr.ampr.org");
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=example.com` }));
    await expect(resolve44net(envWith({}), "oe8apr")).rejects.toThrow(/no valid aprscaching TXT/);
  });
  it("rejects SSIDs, missing records and foreign TXT content", async () => {
    await expect(resolve44net(envWith({}), "OE8APR-7")).rejects.toThrow(/base callsign/);
    stubNet(dohAnswer({ ad: false, status: 3 }));
    await expect(resolve44net(envWith({}), "oe8apr")).rejects.toThrow(/no _aprscaching/);
    stubNet(dohAnswer({ ad: false, txt: "v=spf1 -all" }));
    await expect(resolve44net(envWith({}), "oe8apr")).rejects.toThrow(/no valid aprscaching TXT/);
  });
});

describe("handleFed44netAdd — admission policy", () => {
  it("DNSSEC-validated binding admits automatically as an unvetted peer with a 44net endpoint", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: TXT }), { instance: "oe.pub", publicKey: KEY, publicKeys: [{ x: KEY }] });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.admitted).toBe("dnssec");
    expect(body.peer).toMatchObject({ url: "http://oe8apr.ampr.org", instance: "oe.pub", trust: "unvetted" });
    // the insert pins the DNS key and carries the attested 44net endpoint
    expect(rows).toHaveLength(1);
    expect(rows[0]![2]).toBe(KEY);
    expect(String(rows[0]![3])).toContain('"transport":"44net"');
    expect(String(rows[0]![3])).toContain('"verifiedVia":"ardc-lot"');
  });

  it("without DNSSEC it returns the binding for operator confirmation instead of admitting", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: false, txt: TXT }), { instance: "oe.pub", publicKey: KEY, publicKeys: [{ x: KEY }] });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requiresConfirm: true, resolved: { instance: "oe.pub" } });
    expect(rows).toHaveLength(0); // nothing admitted yet
  });

  it("operator confirm=true pins the non-DNSSEC binding (TOFU)", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: false, txt: TXT }), { instance: "oe.pub", publicKey: KEY, publicKeys: [{ x: KEY }] });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR", confirm: true }), envWith(db));
    expect(res.status).toBe(201);
    expect((await res.json()).admitted).toBe("operator-confirmed");
    expect(rows).toHaveLength(1);
  });

  it("refuses when the live descriptor CONTRADICTS the DNS binding", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: TXT }), { instance: "someone.else", publicKey: KEY, publicKeys: [{ x: KEY }] });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/binding mismatch/);
    expect(rows).toHaveLength(0);
  });

  it("refuses a descriptor that does not list the DNS key among its published keys", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: TXT }), { instance: "oe.pub", publicKey: KEY });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect(rows).toHaveLength(0);
  });

  it("an unreachable descriptor does not block a DNSSEC-validated admission (the DNS key is the pin)", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: TXT })); // descriptor fetch throws
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(201);
    expect((await res.json()).descriptorChecked).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("host= moves the contacted URL, the descriptor cross-check, the stored URL and the endpoint — not trust", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=APRScaching.OE8APR.ampr.org` }), {
      instance: "oe.pub",
      publicKey: KEY,
      publicKeys: [{ x: KEY }],
    });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(fetched).toContain("http://aprscaching.oe8apr.ampr.org/.well-known/aprscaching");
    expect(fetched.some((u) => new URL(u).hostname === "oe8apr.ampr.org")).toBe(false);
    expect(body.peer).toEqual({
      url: "http://aprscaching.oe8apr.ampr.org",
      instance: "oe.pub",
      callsign: "OE8APR", // identity stays the callsign whose zone carries the TXT
      trust: "unvetted",
    });
    expect(rows).toHaveLength(1);
    const [url, instance, key, endpoints] = rows[0]!;
    expect(url).toBe("http://aprscaching.oe8apr.ampr.org");
    expect(instance).toBe("oe.pub");
    expect(key).toBe(KEY); // the key pin is the DNS key, as without host=
    expect(JSON.parse(String(endpoints))).toEqual([
      { transport: "44net", address: "aprscaching.oe8apr.ampr.org", priority: 10, verifiedVia: "ardc-lot" },
    ]);
  });

  it("host= does not change trust: the peer lands unvetted and the insert never sets another tier", async () => {
    const sqls: string[] = [];
    const { db, rows } = peersDb();
    const spy = { prepare: (sql: string) => (sqls.push(sql), db.prepare(sql)) };
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=aprscaching.oe8apr.ampr.org` }));
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(spy));
    expect(res.status).toBe(201);
    expect((await res.json()).peer.trust).toBe("unvetted");
    expect(rows).toHaveLength(1);
    const insert = sqls.find((s) => s.includes("INSERT INTO fed_peers"))!;
    expect(insert).toContain("'unvetted'");
    expect(insert).toContain("trust        = fed_peers.trust");
    expect(insert).not.toMatch(/'trusted'|'blocked'/);
    expect(sqls.filter((s) => /^\s*(UPDATE|DELETE)/i.test(s))).toEqual([]);
  });

  it("a descriptor at host= that contradicts the DNS binding is refused", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=aprscaching.oe8apr.ampr.org` }), {
      instance: "someone.else",
      publicKeys: [{ x: KEY }],
    });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect(fetched).toContain("http://aprscaching.oe8apr.ampr.org/.well-known/aprscaching");
    expect(rows).toHaveLength(0);
  });
});
