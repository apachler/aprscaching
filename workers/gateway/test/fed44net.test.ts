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

/** Stub fetch: DoH queries answer with `doh`; descriptor fetches answer with `wk` (or fail). */
function stubNet(doh: unknown, wk?: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
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
  ({ DB: db, INGEST_SECRET: "sysop-bypass-secret", DOH_URL: "https://dns.example/dns-query" }) as unknown as Env;

const post = (body: unknown) =>
  new Request("http://gw/federation/peers/44net", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-secret": "sysop-bypass-secret" },
    body: JSON.stringify(body),
  });

describe("parse44netTxt", () => {
  it("parses the v=acs1 binding and rejects everything else", () => {
    expect(parse44netTxt(TXT)).toEqual({ instance: "oe.pub", publicKey: KEY });
    expect(parse44netTxt("v=spf1 include:_spf.example.com ~all")).toBeNull();
    expect(parse44netTxt("v=acs1; inst=oe.pub")).toBeNull(); // no key
    expect(parse44netTxt(`v=acs1; inst=oe.pub; key=short`)).toBeNull(); // not a 32-byte key shape
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
    stubNet(dohAnswer({ ad: true, txt: TXT }), { instance: "oe.pub", publicKey: KEY });
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
    stubNet(dohAnswer({ ad: false, txt: TXT }), { instance: "oe.pub", publicKey: KEY });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requiresConfirm: true, resolved: { instance: "oe.pub" } });
    expect(rows).toHaveLength(0); // nothing admitted yet
  });

  it("operator confirm=true pins the non-DNSSEC binding (TOFU)", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: false, txt: TXT }), { instance: "oe.pub", publicKey: KEY });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR", confirm: true }), envWith(db));
    expect(res.status).toBe(201);
    expect((await res.json()).admitted).toBe("operator-confirmed");
    expect(rows).toHaveLength(1);
  });

  it("refuses when the live descriptor CONTRADICTS the DNS binding", async () => {
    const { db, rows } = peersDb();
    stubNet(dohAnswer({ ad: true, txt: TXT }), { instance: "someone.else", publicKey: KEY });
    const res = await handleFed44netAdd(post({ callsign: "OE8APR" }), envWith(db));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/binding mismatch/);
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
});
