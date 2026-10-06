// SPDX-License-Identifier: AGPL-3.0-or-later
// 44net onboarding: the ARDC-delegated <call>.ampr.org name + a DNS-advertised key bind a peer's
// identity. DNSSEC-validated bindings admit automatically; without DNSSEC the operator must confirm
// (TOFU). A descriptor that CONTRADICTS the DNS binding is refused outright, and admission attests
// identity only — the peer lands `unvetted`, and a `blocked` peer is never resurrected by re-adding.
import { describe, it, expect, afterEach } from "vitest";
import { parse44netTxt, resolve44net, resolve44netHost, handleFed44netAdd, host44net } from "../src/fed44net.js";
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
    expect(parse44netTxt(TXT, "OE8APR")).toEqual({
      instance: "oe.pub",
      publicKey: KEY,
      host: "aprscaching.oe8apr.ampr.org",
      web: null,
    });
    expect(parse44netTxt("v=spf1 include:_spf.example.com ~all", "OE8APR")).toBeNull();
    expect(parse44netTxt("v=acs1; inst=oe.pub", "OE8APR")).toBeNull(); // no key
    expect(parse44netTxt(`v=acs1; inst=oe.pub; key=short`, "OE8APR")).toBeNull(); // not a 32-byte key shape
  });
});

// host= moves where the peer is contacted, never out of the callsign's own ARDC zone: a TXT that points
// federation traffic at a third party is refused as a whole.
describe("parse44netTxt — host=", () => {
  const withHost = (h: string) => parse44netTxt(`${TXT}; host=${h}`, "OE8APR");
  it("without host= the peer is aprscaching.<call>.ampr.org", () => {
    expect(parse44netTxt(TXT, "oe8apr")?.host).toBe("aprscaching.oe8apr.ampr.org");
  });
  it("accepts any name under the zone, and refuses the base name itself", () => {
    expect(withHost("oe8apr.ampr.org")).toBeNull();
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
      host: "aprscaching.oe8apr.ampr.org",
      web: null,
      instance: "oe.pub",
      publicKey: KEY,
      dnssec: true,
    });
  });
  it("follows a host= in the zone, and skips a record whose host= leaves it", async () => {
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=node.oe8apr.ampr.org` }));
    expect((await resolve44net(envWith({}), "oe8apr")).host).toBe("node.oe8apr.ampr.org");
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
    expect(body.peer).toMatchObject({
      url: "http://aprscaching.oe8apr.ampr.org",
      instance: "oe.pub",
      trust: "unvetted",
    });
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
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=Node.OE8APR.ampr.org` }), {
      instance: "oe.pub",
      publicKey: KEY,
      publicKeys: [{ x: KEY }],
    });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(fetched).toContain("http://node.oe8apr.ampr.org/.well-known/aprscaching");
    expect(fetched.some((u) => new URL(u).hostname === "oe8apr.ampr.org")).toBe(false);
    expect(body.peer).toEqual({
      url: "http://node.oe8apr.ampr.org",
      instance: "oe.pub",
      callsign: "OE8APR", // identity stays the callsign whose zone carries the TXT
      trust: "unvetted",
    });
    expect(rows).toHaveLength(1);
    const [url, instance, key, endpoints] = rows[0]!;
    expect(url).toBe("http://node.oe8apr.ampr.org");
    expect(instance).toBe("oe.pub");
    expect(key).toBe(KEY); // the key pin is the DNS key, as without host=
    expect(JSON.parse(String(endpoints))).toEqual([
      { transport: "44net", address: "node.oe8apr.ampr.org", priority: 10, verifiedVia: "ardc-lot" },
    ]);
  });

  it("host= does not change trust: the peer lands unvetted and the insert never sets another tier", async () => {
    const sqls: string[] = [];
    const { db, rows } = peersDb();
    const spy = { prepare: (sql: string) => (sqls.push(sql), db.prepare(sql)) };
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=node.oe8apr.ampr.org` }));
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(spy));
    expect(res.status).toBe(201);
    expect((await res.json()).peer.trust).toBe("unvetted");
    expect(rows).toHaveLength(1);
    const insert = sqls.find((s) => s.includes("INSERT INTO fed_peers"))!;
    expect(insert).toContain("'unvetted'");
    expect(insert).toMatch(/trust\s+= fed_peers\.trust/);
    expect(insert).not.toContain("approved_at"); // unvetted, so not approved
    expect(insert).not.toMatch(/'trusted'|'blocked'/);
    // nothing else is changed; only a row discovery alone brought for the instance gives way
    const writes = sqls.filter((s) => /^\s*(UPDATE|DELETE)/i.test(s));
    expect(
      writes.filter((s) => !/^\s*DELETE FROM fed_peers WHERE instance = \? AND url LIKE 'discovered:%'/.test(s)),
    ).toEqual([]);
  });

  it("a descriptor at host= that contradicts the DNS binding is refused", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: `${TXT}; host=node.oe8apr.ampr.org` }), {
      instance: "someone.else",
      publicKeys: [{ x: KEY }],
    });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect(fetched).toContain("http://node.oe8apr.ampr.org/.well-known/aprscaching");
    expect(rows).toHaveLength(0);
  });
});

// ---- per-host records: one callsign, several instances, each under its own name in the callsign's zone

const HOST = "aprscaching-pocket.oe8apr.ampr.org";
const KEY2 = "B".repeat(43);

/**
 * Stub fetch: DoH answers per queried name (`txts[name]`, NXDOMAIN otherwise); each descriptor fetch answers
 * from `wks[host]` (unreachable otherwise).
 */
function stubNames(txts: Record<string, string[]>, wks: Record<string, unknown> = {}, ad = true) {
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    fetched.push(url.toString());
    if (url.hostname === "dns.example") {
      const name = url.searchParams.get("name")!;
      const list = txts[name];
      const doh = list
        ? { Status: 0, AD: ad, Answer: list.map((t) => ({ name, type: 16, data: `"${t}"` })) }
        : { Status: 3, AD: false, Answer: [] };
      return { ok: true, status: 200, json: async () => doh } as Response;
    }
    const wk = wks[url.hostname];
    if (url.pathname === "/.well-known/aprscaching" && wk)
      return { ok: true, status: 200, json: async () => wk } as Response;
    throw new Error("unreachable");
  }) as typeof fetch;
}

/** Mock DB that keeps fed_peers inserts, and answers the instance-binding lookup from `bound`. */
function boundDb(bound: { url: string; instance: string } | null = null) {
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
            // the binding lookup answers; no row blocks the instance
            return sql.includes("FROM fed_peers") && !sql.includes("trust = 'blocked'") ? bound : null;
          },
        }),
      }),
    },
  };
}

describe("host44net", () => {
  it("takes a host in a callsign's zone, and the zone itself", () => {
    expect(host44net(HOST)).toEqual({ callsign: "OE8APR", host: HOST });
    expect(host44net("oe8apr.ampr.org")).toEqual({ callsign: "OE8APR", host: "oe8apr.ampr.org" });
  });
  it("normalises uppercase, spaces and one trailing dot", () => {
    expect(host44net(" APRSCACHING-POCKET.OE8APR.AMPR.ORG. ")).toEqual({ callsign: "OE8APR", host: HOST });
  });
  it("refuses a host outside ampr.org, a bare ampr.org and an invalid base call", () => {
    expect(host44net("pocket.example.com")).toBeNull();
    expect(host44net("ampr.org")).toBeNull();
    expect(host44net("pocket.ab.ampr.org")).toBeNull(); // too short for a callsign
    expect(host44net("pocket.oe8apr-1.ampr.org")).toBeNull(); // an SSID is no zone
    expect(host44net("under_score.oe8apr.ampr.org")).toBeNull();
    expect(host44net("oe8apr.ampr.org..")).toBeNull();
  });
});

describe("resolve44netHost", () => {
  it("reads _aprscaching.<host> and contacts the host itself, without host=", async () => {
    stubNames({ [`_aprscaching.${HOST}`]: [TXT] });
    expect(await resolve44netHost(envWith({}), HOST)).toEqual({
      callsign: "OE8APR",
      host: HOST,
      instance: "oe.pub",
      publicKey: KEY,
      web: null,
      dnssec: true,
    });
    expect(fetched.map((u) => new URL(u).searchParams.get("name"))).toEqual([`_aprscaching.${HOST}`]);
  });
  it("refuses a host outside the callsign's zone before any lookup", async () => {
    stubNames({});
    await expect(resolve44netHost(envWith({}), "pocket.example.com")).rejects.toThrow(/<call>\.ampr\.org/);
    expect(fetched).toEqual([]);
  });
  it("one record at the callsign resolves as before; two are ambiguous", async () => {
    stubNames({ "_aprscaching.oe8apr.ampr.org": [TXT] });
    expect((await resolve44net(envWith({}), "OE8APR")).instance).toBe("oe.pub");
    stubNames({ "_aprscaching.oe8apr.ampr.org": [TXT, TXT] }); // a duplicate is still one binding
    expect((await resolve44net(envWith({}), "OE8APR")).instance).toBe("oe.pub");
  });
});

describe("handleFed44netAdd — by host", () => {
  const wk = (instance: string, key: string) => ({ instance, publicKey: key, publicKeys: [{ x: key }] });

  it("two valid records at one name are refused with 409 and the candidates", async () => {
    const { db, rows } = boundDb();
    stubNames({
      "_aprscaching.oe8apr.ampr.org": [TXT, `v=acs1; inst=oe.pocket; key=${KEY2}; host=${HOST}`],
    });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect((await res.json()).candidates).toEqual([
      { instance: "oe.pub", host: "aprscaching.oe8apr.ampr.org", web: null },
      { instance: "oe.pocket", host: HOST, web: null },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("two hosts of one callsign become two peers, both recording that callsign as the operator", async () => {
    const { db, rows } = boundDb();
    stubNames(
      {
        "_aprscaching.oe8apr.ampr.org": [TXT],
        [`_aprscaching.${HOST}`]: [`v=acs1; inst=oe.pocket; key=${KEY2}`],
      },
      { "aprscaching.oe8apr.ampr.org": wk("oe.pub", KEY), [HOST]: wk("oe.pocket", KEY2) },
    );
    expect((await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db))).status).toBe(201);
    const res = await handleFed44netAdd(post({ host: HOST.toUpperCase() }), envWith(db));
    expect(res.status).toBe(201);
    expect((await res.json()).peer).toEqual({
      url: `http://${HOST}`,
      instance: "oe.pocket",
      callsign: "OE8APR",
      trust: "unvetted",
    });
    expect(rows.map((r) => [r[0], r[1], r[2], r[4]])).toEqual([
      ["http://aprscaching.oe8apr.ampr.org", "oe.pub", KEY, "OE8APR"],
      [`http://${HOST}`, "oe.pocket", KEY2, "OE8APR"],
    ]);
  });

  it("cross-checks the descriptor at the host and pins the host's DNS key", async () => {
    const { db, rows } = boundDb();
    stubNames({ [`_aprscaching.${HOST}`]: [TXT] }, { [HOST]: wk("someone.else", KEY) });
    const res = await handleFed44netAdd(post({ host: HOST }), envWith(db));
    expect(res.status).toBe(409);
    expect(fetched).toContain(`http://${HOST}/.well-known/aprscaching`);
    expect(rows).toHaveLength(0);

    stubNames({ [`_aprscaching.${HOST}`]: [TXT] }, { [HOST]: wk("oe.pub", KEY) });
    expect((await handleFed44netAdd(post({ host: HOST }), envWith(db))).status).toBe(201);
    expect(rows[0]![2]).toBe(KEY);
    expect(JSON.parse(String(rows[0]![3]))).toEqual([
      { transport: "44net", address: HOST, priority: 10, verifiedVia: "ardc-lot" },
    ]);
  });

  it("an instance id another live peer holds is refused", async () => {
    const { db, rows } = boundDb({ url: "https://oe.pub", instance: "oe.pub" });
    stubNames({ [`_aprscaching.${HOST}`]: [TXT] });
    const res = await handleFed44netAdd(post({ host: HOST }), envWith(db));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/instance binding conflict/);
    expect(rows).toHaveLength(0);
  });

  it("an instance blocked under another address is refused, not added at this one", async () => {
    const rows: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          async run() {
            if (sql.includes("INSERT INTO fed_peers")) rows.push(args);
            return {};
          },
          async first() {
            // only the blocked row names the instance; the live-row conflict lookup skips it
            return sql.includes("trust = 'blocked'") ? { url: "https://old.example" } : null;
          },
        }),
      }),
    };
    stubNames({ [`_aprscaching.${HOST}`]: [TXT] });
    const res = await handleFed44netAdd(post({ host: HOST }), envWith(db));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/oe\.pub is blocked here \(at https:\/\/old\.example\)/);
    expect(rows).toHaveLength(0);
  });

  it("without DNSSEC a host binding waits for the operator's confirm, like a callsign's", async () => {
    const { db, rows } = boundDb();
    stubNames({ [`_aprscaching.${HOST}`]: [TXT] }, {}, false);
    const res = await handleFed44netAdd(post({ host: HOST }), envWith(db));
    expect(await res.json()).toMatchObject({ requiresConfirm: true, resolved: { host: HOST, callsign: "OE8APR" } });
    expect(rows).toHaveLength(0);
  });

  it("refuses a host outside the zone, and a callsign together with a host", async () => {
    const { db, rows } = boundDb();
    stubNames({});
    expect((await handleFed44netAdd(post({ host: "pocket.example.com" }), envWith(db))).status).toBe(400);
    expect((await handleFed44netAdd(post({ callsign: "OE8APR", host: HOST }), envWith(db))).status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it("a host binding changes no trust: unvetted, and re-adding keeps the tier", async () => {
    const sqls: string[] = [];
    const { db, rows } = boundDb();
    const spy = { prepare: (sql: string) => (sqls.push(sql), db.prepare(sql)) };
    stubNames({ [`_aprscaching.${HOST}`]: [TXT] });
    const res = await handleFed44netAdd(post({ host: HOST }), envWith(spy));
    expect((await res.json()).peer.trust).toBe("unvetted");
    expect(rows).toHaveLength(1);
    const insert = sqls.find((s) => s.includes("INSERT INTO fed_peers"))!;
    expect(insert).toMatch(/trust\s+= fed_peers\.trust/);
    expect(insert).not.toContain("approved_at"); // unvetted, so not approved
    expect(insert).not.toMatch(/'trusted'|'blocked'/);
  });
});

// ---- web=: an identity under the callsign for an instance on the internet, with or without 44Net

describe("parse44netTxt — web=", () => {
  it("takes an https origin, and names no 44Net host without host=", () => {
    expect(parse44netTxt(`${TXT}; web=https://APRS.Example.net`, "OE8APR")).toEqual({
      instance: "oe.pub",
      publicKey: KEY,
      host: null,
      web: "https://aprs.example.net",
    });
    expect(parse44netTxt(`${TXT}; web=https://aprs.example.net:8443/`, "OE8APR")?.web).toBe(
      "https://aprs.example.net:8443",
    );
  });
  it("with host= both endpoints are known", () => {
    expect(
      parse44netTxt(`${TXT}; host=aprscaching.oe8apr.ampr.org; web=https://aprs.example.net`, "OE8APR"),
    ).toMatchObject({ host: "aprscaching.oe8apr.ampr.org", web: "https://aprs.example.net" });
  });
  it("rejects the whole record for anything but an https origin", () => {
    for (const w of [
      "http://aprs.example.net",
      "aprs.example.net",
      "https://aprs.example.net/path",
      "https://user@aprs.example.net",
      "https://aprs.example.net?x=1",
      "https://aprs.example.net#x",
      "",
    ])
      expect(parse44netTxt(`${TXT}; web=${w}`, "OE8APR")).toBeNull();
  });
});

describe("handleFed44netAdd — by callsign over the internet (web=)", () => {
  const WEB = "https://aprs.example.net";
  const ZONE_TXT = "_aprscaching.oe8apr.ampr.org";
  const wk = (instance: string, key: string, aprsCall = "OE8APR-15") => ({
    instance,
    publicKey: key,
    publicKeys: [{ x: key }],
    aprsCall,
  });

  it("internet only: fetches the descriptor at the origin and stores one https endpoint", async () => {
    const { db, rows } = boundDb();
    stubNames({ [ZONE_TXT]: [`${TXT}; web=${WEB}`] }, { "aprs.example.net": wk("oe.pub", KEY) });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(201);
    expect(fetched).toContain(`${WEB}/.well-known/aprscaching`);
    expect(fetched.some((u) => u.startsWith("http://"))).toBe(false); // no 44Net contact
    expect((await res.json()).peer).toEqual({ url: WEB, instance: "oe.pub", callsign: "OE8APR", trust: "unvetted" });
    expect(rows[0]![0]).toBe(WEB);
    expect(rows[0]![2]).toBe(KEY);
    expect(rows[0]![4]).toBe("OE8APR");
    expect(JSON.parse(String(rows[0]![3]))).toEqual([
      { transport: "https", address: WEB, priority: 10, verifiedVia: "ardc-lot" },
    ]);
  });

  it("refuses a descriptor whose keys do not include the DNS key, or whose instance differs", async () => {
    const { db, rows } = boundDb();
    stubNames({ [ZONE_TXT]: [`${TXT}; web=${WEB}`] }, { "aprs.example.net": wk("oe.pub", KEY2) });
    let res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/binding mismatch.*not among the active keys/);
    stubNames({ [ZONE_TXT]: [`${TXT}; web=${WEB}`] }, { "aprs.example.net": wk("third.party", KEY) });
    res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect(rows).toHaveLength(0);
  });

  it("refuses another instance's id and key copied into a record: its descriptor must name the callsign", async () => {
    const { db, rows } = boundDb();
    stubNames({ [ZONE_TXT]: [`${TXT}; web=${WEB}`] }, { "aprs.example.net": wk("oe.pub", KEY, "DL1ABC-15") });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR", confirm: true }), envWith(db));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/names no call of OE8APR/);
    expect(rows).toHaveLength(0);
    // FED_OPERATOR naming the call is the origin's word too
    stubNames(
      { [ZONE_TXT]: [`${TXT}; web=${WEB}`] },
      { "aprs.example.net": { ...wk("oe.pub", KEY, "APRSCG"), operator: "oe8apr" } },
    );
    expect((await handleFed44netAdd(post({ callsign: "OE8APR", confirm: true }), envWith(db))).status).toBe(201);
  });

  it("refuses when the origin does not answer: the key is checked there before it is pinned", async () => {
    const { db, rows } = boundDb();
    stubNames({ [ZONE_TXT]: [`${TXT}; web=${WEB}`] });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR", confirm: true }), envWith(db));
    expect(res.status).toBe(502);
    expect(rows).toHaveLength(0);
  });

  it("without DNSSEC the operator still confirms once", async () => {
    const { db, rows } = boundDb();
    stubNames({ [ZONE_TXT]: [`${TXT}; web=${WEB}`] }, { "aprs.example.net": wk("oe.pub", KEY) }, false);
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(await res.json()).toMatchObject({
      requiresConfirm: true,
      descriptorChecked: true,
      resolved: { web: WEB, host: null },
    });
    expect(rows).toHaveLength(0);
  });

  it("both: https first for an instance off 44Net, 44Net first for one on it", async () => {
    const both = `${TXT}; host=aprscaching.oe8apr.ampr.org; web=${WEB}`;
    const wks = { "aprs.example.net": wk("oe.pub", KEY) };
    const off = boundDb();
    stubNames({ [ZONE_TXT]: [both] }, wks);
    expect((await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(off.db))).status).toBe(201);
    expect(off.rows[0]![0]).toBe(WEB);
    expect(JSON.parse(String(off.rows[0]![3]))).toEqual([
      { transport: "https", address: WEB, priority: 10, verifiedVia: "ardc-lot" },
      { transport: "44net", address: "aprscaching.oe8apr.ampr.org", priority: 20, verifiedVia: "ardc-lot" },
    ]);
    const on = boundDb();
    stubNames({ [ZONE_TXT]: [both] }, wks);
    const on44 = {
      ...envWith(on.db),
      FED_ENDPOINTS: '[{"transport":"44net","address":"aprscaching.dl1abc.ampr.org","priority":10}]',
    } as Env;
    expect((await handleFed44netAdd(post({ callsign: "OE8APR" }), on44)).status).toBe(201);
    const order = (JSON.parse(String(on.rows[0]![3])) as { transport: string; priority: number }[]).map((e) => [
      e.transport,
      e.priority,
    ]);
    expect(order).toEqual([
      ["https", 20],
      ["44net", 10],
    ]);
  });

  it("a 44Net descriptor contradicting the binding is refused even when the origin matches", async () => {
    const { db, rows } = boundDb();
    stubNames(
      { [ZONE_TXT]: [`${TXT}; host=aprscaching.oe8apr.ampr.org; web=${WEB}`] },
      { "aprs.example.net": wk("oe.pub", KEY), "aprscaching.oe8apr.ampr.org": wk("someone.else", KEY) },
    );
    expect((await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db))).status).toBe(409);
    expect(rows).toHaveLength(0);
  });
});

describe("resolve44netHost — the callsign's record as fallback", () => {
  it("a host without a record of its own takes the callsign's when that one sends peers to it", async () => {
    stubNames({ "_aprscaching.oe8apr.ampr.org": [TXT] });
    expect((await resolve44netHost(envWith({}), "aprscaching.oe8apr.ampr.org")).host).toBe(
      "aprscaching.oe8apr.ampr.org",
    );
    stubNames({ "_aprscaching.oe8apr.ampr.org": [TXT] });
    await expect(resolve44netHost(envWith({}), HOST)).rejects.toThrow(/no _aprscaching/);
  });
  it("the base name reads the callsign's record", async () => {
    stubNames({ "_aprscaching.oe8apr.ampr.org": [TXT] });
    expect((await resolve44netHost(envWith({}), "oe8apr.ampr.org")).host).toBe("aprscaching.oe8apr.ampr.org");
  });
});
