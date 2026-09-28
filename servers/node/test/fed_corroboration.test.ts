// SPDX-License-Identifier: AGPL-3.0-or-later
// Cross-instance corroboration is the one exchange that can mint Tier A, so it is a signed exchange:
// the asker signs its question with a fresh nonce, the answerer signs a reply bound to that nonce and
// to the question's hash, and the asker counts only verified replies from distinct identities. These
// tests run real instances (the gateway's own handle()) behind a stubbed fetch.
import { describe, it, expect, afterEach, vi } from "vitest";
import { decodeFedFrame } from "@aprscaching/shared";
import { queryPeerCorroboration, type CorroborationQuery } from "@aprscaching/gateway/corroborate";
import { scoreFind } from "@aprscaching/gateway/caches";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import { newFedKey, instanceEnv, serve, stubFetch, type FedKey, type Serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => {
  vi.unstubAllGlobals();
});

const LOGGER = "OE8LOG";
const SITE = "OE8XXX";
const LAT = 47.0707;
const LON = 15.4395;
const now = () => Math.floor(Date.now() / 1000);

/** An answering instance that heard LOGGER on RF at (lat, lon) through an attested site. */
async function answerer(instance: string, opts: { lat?: number; lon?: number; igate?: string; extra?: object } = {}) {
  const key = await newFedKey();
  const env = instanceEnv(instance, key, { FIRST_PARTY_SITES: opts.igate ?? SITE, ...(opts.extra ?? {}) });
  await env.DB.prepare(
    "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, source) VALUES (?, ?, ?, ?, 'rf', ?, 'aprs')",
  )
    .bind(LOGGER, now() - 600, opts.lat ?? LAT, opts.lon ?? LON, opts.igate ?? SITE)
    .run();
  return { key, env, instance };
}

async function asker(extra: Record<string, unknown> = {}) {
  const key = await newFedKey();
  return { key, env: instanceEnv("hub.example", key, extra) };
}

async function addPeer(env: Env, url: string, instance: string, key: FedKey, trust = "trusted") {
  await env.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, ?, ?, ?, ?, 'manual')",
  )
    .bind(url, instance, key.pub, JSON.stringify([{ x: key.pub }]), trust)
    .run();
}

/** Every asker must be known to the answerer for it to answer when it requires known askers. */
async function knowAsker(ans: Env, hub: { key: FedKey }) {
  await addPeer(ans, "https://hub.example", "hub.example", hub.key);
}

const query = (over: Partial<CorroborationQuery> = {}): CorroborationQuery => ({
  callsign: LOGGER,
  lat: LAT,
  lon: LON,
  radiusM: 150,
  since: now() - 1800,
  until: now(),
  ...over,
});

const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");

/** A route that answers the asker's real question with a reply the test tampers with. */
function forged(
  signer: Env,
  origin: string,
  tamper: (body: Record<string, unknown>, rec: { at: number }) => void = () => {},
): Serve {
  return async (req) => {
    const q = decodeFedFrame(new Uint8Array(await req.arrayBuffer()));
    const body: Record<string, unknown> = {
      nonce: q.record.body.nonce,
      queryHash: hex(await crypto.subtle.digest("SHA-256", q.payload)),
      corroborated: true,
      distanceCm: 10000,
      ts: now() - 1200,
    };
    const rec = { at: now() };
    tamper(body, rec);
    const frame = await signFedRecord(signer, {
      kind: "corroboration",
      gid: `${origin}:corroboration:${String(q.record.body.nonce)}`,
      origin,
      v: rec.at,
      at: rec.at,
      signer: origin,
      body,
    });
    return new Response(frame as BodyInit, { headers: { "content-type": "application/cbor" } });
  };
}

describe("signed corroboration answers", () => {
  it("counts a genuine signed answer", async () => {
    const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
    const p1 = await answerer("p1.example");
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    stubFetch({ "https://p1.example": serve(p1.env) });
    const ev = await queryPeerCorroboration(hub.env, query());
    expect(ev?.instance).toBe("p1.example");
  });

  const forgeries: Array<[string, (p1: { env: Env; key: FedKey }, evil: Env) => Serve]> = [
    [
      "an unsigned JSON answer",
      () => async () => Response.json({ corroborated: true, evidence: { distanceM: 50, ts: now() } }),
    ],
    ["an answer signed by a key the peer never proved", (_p1, evil) => forged(evil, "p1.example")],
    ["an answer with the wrong nonce", (p1) => forged(p1.env, "p1.example", (b) => (b.nonce = "00".repeat(16)))],
    ["a stale answer", (p1) => forged(p1.env, "p1.example", (_b, r) => (r.at = now() - 3600))],
    ["an answer to a different question", (p1) => forged(p1.env, "p1.example", (b) => (b.queryHash = "ab".repeat(32)))],
  ];
  for (const [name, route] of forgeries)
    it(`ignores ${name}`, async () => {
      const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
      const p1 = await answerer("p1.example");
      const evil = instanceEnv("p1.example", await newFedKey());
      await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
      stubFetch({ "https://p1.example": route(p1, evil) });
      expect(await queryPeerCorroboration(hub.env, query())).toBeNull();
    });

  it("lets a plain-http (44net) peer corroborate only with a signed answer", async () => {
    const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
    const p1 = await answerer("p1.example");
    await addPeer(hub.env, "http://p1.example", "p1.example", p1.key);
    const routes = stubFetch({ "http://p1.example": serve(p1.env) });
    expect((await queryPeerCorroboration(hub.env, query()))?.instance).toBe("p1.example");
    routes["http://p1.example"] = async () =>
      Response.json({ corroborated: true, evidence: { distanceM: 1, ts: now() } });
    expect(await queryPeerCorroboration(hub.env, query())).toBeNull();
  });
});

describe("quorum", () => {
  it("needs two distinct verified peers by default", async () => {
    const hub = await asker();
    const p1 = await answerer("p1.example");
    const p2 = await answerer("p2.example");
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    const routes = stubFetch({ "https://p1.example": serve(p1.env), "https://p2.example": serve(p2.env) });
    expect(await queryPeerCorroboration(hub.env, query())).toBeNull(); // one voice is not enough

    await addPeer(hub.env, "https://p2.example", "p2.example", p2.key);
    const ev = await queryPeerCorroboration(hub.env, query());
    expect(ev?.corroborators).toBe(2);

    routes["https://p2.example"] = async () =>
      Response.json({ corroborated: true, evidence: { distanceM: 1, ts: now() } });
    expect(await queryPeerCorroboration(hub.env, query())).toBeNull(); // an unsigned answer never counts
  });

  it("counts one signing key once, however many instance ids answer with it", async () => {
    const hub = await asker();
    const p1 = await answerer("p1.example");
    const twin = instanceEnv("p1-44net.example", p1.key, { FIRST_PARTY_SITES: SITE }, p1.env.DB);
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    await addPeer(hub.env, "http://p1-44net.example", "p1-44net.example", p1.key);
    stubFetch({ "https://p1.example": serve(p1.env), "http://p1-44net.example": serve(twin) });
    expect(await queryPeerCorroboration(hub.env, query())).toBeNull();
  });

  it("counts two instances of one registry operator once", async () => {
    const authority = await newFedKey();
    const p1 = await answerer("p1.example");
    const p2 = await answerer("p2.example");
    const { signedRegistry } = await import("./helpers/fedpeer.js");
    const doc = await signedRegistry(authority, 100, [
      { instance: "p1.example", key: p1.key.pub, operator: "OE8ONE" },
      { instance: "p2.example", key: p2.key.pub, operator: "OE8ONE" },
    ]);
    const hub = await asker({ FED_REGISTRY: JSON.stringify(doc), FED_REGISTRY_KEY: authority.pub });
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    await addPeer(hub.env, "https://p2.example", "p2.example", p2.key);
    stubFetch({ "https://p1.example": serve(p1.env), "https://p2.example": serve(p2.env) });
    expect(await queryPeerCorroboration(hub.env, query())).toBeNull();
  });
});

describe("requests", () => {
  it("never sends the corroboration secret to a plain-http or unvetted peer", async () => {
    const seen: Record<string, string | null> = {};
    const hub = await asker({
      FED_CORROBORATION_SECRET: "s3cret",
      FED_AUTO_PROMOTE: "3",
      FED_CORROBORATION_QUORUM: "1",
    });
    const peers = [
      ["https://trusted.example", "trusted.example", "trusted"],
      ["http://plain.example", "plain.example", "trusted"],
      ["https://new.example", "new.example", "unvetted"],
    ] as const;
    const routes: Record<string, Serve> = {};
    for (const [url, instance, trust] of peers) {
      const p = await answerer(instance, { extra: { FED_CORROBORATION_SECRET: "s3cret" } });
      await addPeer(hub.env, url, instance, p.key, trust);
      routes[url] = async (req) => {
        seen[instance] = req.headers.get("x-fed-secret");
        return serve(p.env)(req);
      };
    }
    stubFetch(routes);
    await queryPeerCorroboration(hub.env, query());
    expect(seen["trusted.example"]).toBe("s3cret");
    expect(seen["plain.example"]).toBeNull();
    expect(seen["new.example"]).toBeNull();
  });

  it("refuses an unsigned request, and an unknown asker when known askers are required", async () => {
    const p1 = await answerer("p1.example", { extra: { FED_CORROBORATION_REQUIRE_KNOWN: "1" } });
    const json = await serve(p1.env)(
      new Request("https://p1.example/federation/corroborate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query()),
      }),
    );
    expect(json.status).toBe(415);

    const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    let status = 0;
    stubFetch({
      "https://p1.example": async (req) => {
        const r = await serve(p1.env)(req);
        status = r.status;
        return r;
      },
    });
    expect(await queryPeerCorroboration(hub.env, query())).toBeNull();
    expect(status).toBe(401);
    await knowAsker(p1.env, hub);
    expect((await queryPeerCorroboration(hub.env, query()))?.instance).toBe("p1.example");
  });

  it("forwards the logger's own IGates as exclusions", async () => {
    const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
    const p1 = await answerer("p1.example", { igate: "OE8CLB-10" });
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    stubFetch({ "https://p1.example": serve(p1.env) });
    expect(await queryPeerCorroboration(hub.env, query({ excludeIgates: ["OE8CLB"] }))).toBeNull();
    expect((await queryPeerCorroboration(hub.env, query()))?.instance).toBe("p1.example");
  });
});

describe("evidence", () => {
  it("takes the instance from the verified peer and drops an IGate the asker did not opt into", async () => {
    const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
    const p1 = await answerer("p1.example");
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    stubFetch({
      "https://p1.example": forged(p1.env, "p1.example", (b) => {
        b.instance = "someone-else.example";
        b.igateCall = "OE8VIC";
      }),
    });
    const ev = await queryPeerCorroboration(hub.env, query());
    expect(ev?.instance).toBe("p1.example");
    expect(ev?.igateCall).toBeUndefined();
  });

  for (const [name, t] of [
    ["a negative distance", (b: Record<string, unknown>) => (b.distanceCm = -500)],
    ["a distance beyond the query radius", (b: Record<string, unknown>) => (b.distanceCm = 50_000_000)],
    ["a time outside the query window", (b: Record<string, unknown>) => (b.ts = now() - 90 * 86400)],
  ] as const)
    it(`rejects ${name}`, async () => {
      const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
      const p1 = await answerer("p1.example");
      await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
      stubFetch({ "https://p1.example": forged(p1.env, "p1.example", t) });
      expect(await queryPeerCorroboration(hub.env, query())).toBeNull();
    });
});

describe("the answerer is not a location or time oracle", () => {
  async function ask(p1: { env: Env; key: FedKey }, q: Partial<CorroborationQuery>) {
    const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    stubFetch({ "https://p1.example": serve(p1.env) });
    return queryPeerCorroboration(hub.env, query(q));
  }

  it("widens a 1 m radius to the minimum, so it cannot pinpoint", async () => {
    const p1 = await answerer("p1.example", { lat: LAT + 0.001 }); // ~110 m north
    expect((await ask(p1, { radiusM: 1 }))?.instance).toBe("p1.example");
  });

  it("refuses a window that ended long ago", async () => {
    const p1 = await answerer("p1.example");
    expect(await ask(p1, { since: now() - 30 * 86400 - 1800, until: now() - 30 * 86400 })).toBeNull();
  });
});

describe("peer-corroborated finds still need a plausible local track", () => {
  async function setup() {
    const hub = await asker();
    const p1 = await answerer("p1.example");
    const p2 = await answerer("p2.example");
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    await addPeer(hub.env, "https://p2.example", "p2.example", p2.key);
    stubFetch({ "https://p1.example": serve(p1.env), "https://p2.example": serve(p2.env) });
    return hub;
  }
  const cache = { id: 1, code: "AC-1", type: "traditional", lat: LAT, lon: LON, min_trust: null } as never;

  it("reaches Tier A when nothing local contradicts it", async () => {
    const hub = await setup();
    const s = await scoreFind(hub.env, cache, LOGGER, now());
    expect(s.result.tier).toBe("A");
    expect(s.result.method).toBe("aprs_rf_peer");
  });

  it("is refused when the logger's own local fix puts them hundreds of km away", async () => {
    const hub = await setup();
    await hub.env.DB.prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, source) VALUES (?, ?, 52.52, 13.40, 'aprs_is', 'DB0XX', 'aprs')",
    )
      .bind(LOGGER, now() - 1100)
      .run();
    const s = await scoreFind(hub.env, cache, LOGGER, now());
    expect(s.result.tier).not.toBe("A");
  });

  it("asks about a living cache where its station was, not where it was hidden", async () => {
    const hub = await asker({ FED_CORROBORATION_QUORUM: "1" });
    const p1 = await answerer("p1.example", { lat: 48.2, lon: 16.37 }); // the station drove to Vienna
    await addPeer(hub.env, "https://p1.example", "p1.example", p1.key);
    stubFetch({ "https://p1.example": serve(p1.env) });
    await hub.env.DB.prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, source) VALUES ('OE8CAR-9', ?, 48.2, 16.37, 'rf', ?, 'aprs')",
    )
      .bind(now() - 700, SITE)
      .run();
    const living = {
      id: 2,
      code: "AC-2",
      type: "aprs_living",
      station_call: "OE8CAR-9",
      lat: LAT,
      lon: LON,
      min_trust: null,
    };
    const s = await scoreFind(hub.env, living as never, LOGGER, now());
    expect(s.result.method).toBe("aprs_rf_peer");
  });
});

describe("answerer limits are per asker", () => {
  it("one asker exhausting a callsign's budget does not silence another asker", async () => {
    const p1 = await answerer("p1.example");
    const noisy = await asker({ FED_CORROBORATION_QUORUM: "1" });
    const quiet = await asker({ FED_CORROBORATION_QUORUM: "1" });
    for (const h of [noisy, quiet]) await addPeer(h.env, "https://p1.example", "p1.example", p1.key);
    let limited = 0;
    stubFetch({
      "https://p1.example": async (req) => {
        const body = await req.arrayBuffer();
        const headers = new Headers(req.headers);
        headers.set("x-real-ip", decodeFedFrame(new Uint8Array(body)).signerKey); // one host per asker
        const r = await serve(p1.env)(new Request(req.url, { method: "POST", headers, body }));
        if (r.status === 429) limited++;
        return r;
      },
    });
    for (let i = 0; i < 62; i++) await queryPeerCorroboration(noisy.env, query());
    expect(limited).toBeGreaterThan(0);
    // a distinct asker key is a distinct budget
    const quietHub = instanceEnv("quiet.example", quiet.key, { FED_CORROBORATION_QUORUM: "1" }, quiet.env.DB);
    expect((await queryPeerCorroboration(quietHub, query()))?.instance).toBe("p1.example");
  });
});
