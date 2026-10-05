// SPDX-License-Identifier: AGPL-3.0-or-later
// The ways a peer row is made or changed, over real instances: a block covers the instance on every path that
// could bring it back (a pull, the registry, discovery, a push, a trust change); a FED_PEERS fingerprint pin
// holds across a key rotation; a peer's own descriptor and beacons tell where else it answers, and
// corroboration asks it there too; trust needs the compared fingerprint, and an automatic promotion keeps how
// the peer arrived.
import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers, applyFedFrames } from "@aprscaching/gateway/federation_sync";
import { queryPeerCorroboration } from "@aprscaching/gateway/corroborate";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import {
  newFedKey,
  instanceEnv,
  addCache,
  serve,
  stubFetch,
  peerRow,
  remoteCacheCount,
  rotation,
  signedRegistry,
  type FedKey,
} from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const A = "https://a.example";
const A2 = "https://a2.example";
const OP = { "x-operator-secret": "test-operator-secret" };
const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);

const fp = (k: FedKey) =>
  createHash("sha256")
    .update(Buffer.from(k.pub, "base64url"))
    .digest("hex")
    .slice(0, 16)
    .replace(/(.{4})(?=.)/g, "$1 ");

async function req(env: Env, method: string, path: string, body?: unknown) {
  const res = await serve(env)(
    new Request(`https://hub.example${path}`, {
      method,
      headers: { "content-type": "application/json", ...OP },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

async function insertPeer(env: Env, url: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  await env.DB.prepare(`INSERT INTO fed_peers (url, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`)
    .bind(url, ...keys.map((k) => cols[k]))
    .run();
}

/** Peer a.example (key `key`) answering at A, and A2 when asked; a hub that blocked it at A. */
async function blockedAtA(hubExtra: Record<string, unknown> = {}) {
  const key = await newFedKey();
  const a = instanceEnv("a.example", key);
  await addCache(a);
  const routes = stubFetch({ [A]: serve(a), [A2]: serve(a) });
  const hub = instanceEnv("hub.example", await newFedKey(), hubExtra);
  await insertPeer(hub, A, { instance: "a.example", public_key: key.pub, trust: "blocked", added_via: "admin" });
  return { key, a, routes, hub };
}

describe("a block covers the instance on every path", () => {
  it("a pull from another address of a blocked instance is refused and binds nothing", async () => {
    const { hub } = await blockedAtA({ FED_PEERS: A2 });
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/a\.example is blocked here \(at https:\/\/a\.example\)/);
    expect(await peerRow(hub, A2)).toMatchObject({ instance: null, public_key: null });
    expect(await remoteCacheCount(hub, "a.example")).toBe(0);
  });

  it("the registry seeds no new address for a blocked instance", async () => {
    const authority = await newFedKey();
    const { key, hub } = await blockedAtA();
    hub.FED_REGISTRY_KEY = authority.pub;
    hub.FED_REGISTRY = JSON.stringify(
      await signedRegistry(authority, nowS(), [{ instance: "a.example", key: key.pub, url: A2 }]),
    );
    await req(hub, "GET", "/federation/peers"); // seeds
    expect(await peerRow(hub, A2)).toBeNull();
  });

  it("a discovered address that serves a blocked instance is refused once enabled", async () => {
    const pKey = await newFedKey();
    const p = instanceEnv("p.example", pKey, { FED_PEERS: A2 }); // advertises A2 in its descriptor
    const { routes, hub } = await blockedAtA({ FED_DISCOVER: "1" });
    routes["https://p.example"] = serve(p);
    await insertPeer(hub, "https://p.example", {
      instance: "p.example",
      public_key: pKey.pub,
      accept_keys: JSON.stringify([{ x: pKey.pub }]),
      trust: "trusted",
      added_via: "manual",
    });
    await syncAllPeers(hub);
    expect(await peerRow(hub, A2)).toMatchObject({ added_via: "discovered", enabled: 0 });
    expect((await req(hub, "POST", "/federation/peers/trust", { url: A2, trust: "unvetted" })).status).toBe(200);
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/blocked here/);
    expect((await peerRow(hub, A2))?.instance).toBeNull();
    expect(await remoteCacheCount(hub, "a.example")).toBe(0);
  });

  it("a push from an instance blocked under its pull address is refused", async () => {
    const { a, hub } = await blockedAtA();
    hub.FED_SUBMIT_SECRET = "submit-secret";
    const page = await (await serve(a)(new Request(`${A}/federation/sync/cache?since=0`))).arrayBuffer();
    const res = await serve(hub)(
      new Request("https://hub.example/federation/submit", {
        method: "POST",
        headers: { "content-type": "application/cbor", "x-fed-secret": "submit-secret" },
        body: page,
      }),
    );
    expect(res.status).toBe(403);
    expect(await peerRow(hub, "submit:a.example")).toBeNull();
    expect(await remoteCacheCount(hub, "a.example")).toBe(0);
  });

  it("blocking one address blocks every row of the instance; lifting it waits for the others", async () => {
    const key = await newFedKey();
    const hub = instanceEnv("hub.example", await newFedKey());
    await insertPeer(hub, A, { instance: "a.example", public_key: key.pub, trust: "trusted", added_via: "admin" });
    await insertPeer(hub, "submit:a.example", {
      instance: "a.example",
      public_key: key.pub,
      trust: "blocked",
      added_via: "submitted",
      enabled: 0,
    });
    // a live row beside a blocked one: the trust endpoint refuses to keep it live
    const keep = await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "unvetted" });
    expect(keep.status).toBe(409);
    expect(keep.data.error).toMatch(/blocked here at submit:a\.example/);

    // blocking it is always possible, and every row of the instance is blocked then
    expect((await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "blocked" })).status).toBe(200);
    const rows = (
      await hub.DB.prepare("SELECT trust FROM fed_peers WHERE instance = 'a.example'").all<{ trust: string }>()
    ).results;
    expect(rows.map((r) => r.trust)).toEqual(["blocked", "blocked"]);
    expect((await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "unvetted" })).status).toBe(409);
    // once the other address is removed, the block lifts
    await req(hub, "DELETE", `/federation/peers?url=${encodeURIComponent("submit:a.example")}`);
    expect((await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "unvetted" })).status).toBe(200);
  });
});

describe("a FED_PEERS fingerprint pin across a key rotation", () => {
  async function pinnedPeer() {
    const k1 = await newFedKey();
    const old = instanceEnv("a.example", k1);
    await addCache(old);
    const routes = stubFetch({ [A]: serve(old) });
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_PEERS: `${A}#${fp(k1).replace(/ /g, "")}` });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "trusted", public_key: k1.pub, pin_matched_key: k1.pub });
    return { k1, old, routes, hub };
  }

  async function rotate(k1: FedKey, db: unknown) {
    const k2 = await newFedKey();
    const at = nowS();
    const env = instanceEnv(
      "a.example",
      k2,
      {
        FED_KEY_HISTORY: JSON.stringify([{ x: k1.pub, until: at + 2 * DAY }]),
        FED_ROTATIONS: JSON.stringify([await rotation(k1, k2, at)]),
      },
      db,
    );
    return { k2, at, env };
  }

  it("still syncs once the pinned key's grace has passed", async () => {
    const { k1, old, routes, hub } = await pinnedPeer();
    const { k2, at, env } = await rotate(k1, old.DB);
    routes[A] = serve(env);
    expect((await syncAllPeers(hub)).errors).toEqual([]); // inside the grace
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((at + 10 * DAY) * 1000);
    await addCache(env, at + 5 * DAY);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "trusted", public_key: k2.pub });
    expect(await remoteCacheCount(hub, "a.example")).toBe(2);
  });

  it("follows a rotation first seen after the grace", async () => {
    const { k1, old, routes, hub } = await pinnedPeer();
    const { k2, at, env } = await rotate(k1, old.DB);
    routes[A] = serve(env);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((at + 10 * DAY) * 1000);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect((await peerRow(hub, A))?.public_key).toBe(k2.pub);
  });

  it("refuses an unrelated key on the pinned address, and a pin no key matches", async () => {
    const { routes, hub } = await pinnedPeer();
    routes[A] = serve(instanceEnv("a.example", await newFedKey()));
    expect((await syncAllPeers(hub)).errors.join()).toMatch(/rotation|hijack/);

    const stranger = await newFedKey();
    const fresh = instanceEnv("hub2.example", await newFedKey(), {
      FED_PEERS: `${A}#${fp(stranger).replace(/ /g, "")}`,
    });
    expect((await syncAllPeers(fresh)).errors.join()).toMatch(/fingerprint pinned in FED_PEERS/);
  });

  it("re-seeding keeps how a peer first arrived", async () => {
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_PEERS: A });
    await insertPeer(hub, A, { trust: "unvetted", added_via: "registry" });
    await req(hub, "GET", "/federation/peers");
    expect((await peerRow(hub, A))?.added_via).toBe("registry");
  });
});

describe("a peer's own addresses", () => {
  const ALT = "https://alt.a.example";

  it("a peer added by URL learns the addresses its descriptor lists, and syncs at them", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key, {
      FED_ENDPOINTS: JSON.stringify([{ transport: "https", address: ALT, priority: 10 }]),
    });
    await addCache(a);
    const routes = stubFetch({ [A]: serve(a), [ALT]: serve(a) });
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_PEERS: A });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    const row = await peerRow(hub, A);
    expect(row?.endpoints_source).toBe("descriptor");
    expect(JSON.parse(String(row?.endpoints))).toEqual([{ transport: "https", address: ALT, priority: 10 }]);
    // the address it was added under stays a way in, last
    delete routes[ALT];
    await addCache(a, 5000);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await remoteCacheCount(hub, "a.example")).toBe(2);
    routes[ALT] = serve(a);
    delete routes[A];
    await addCache(a, 6000);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await remoteCacheCount(hub, "a.example")).toBe(3);
  });

  it("a descriptor never replaces the endpoints DNS set", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key, {
      FED_ENDPOINTS: JSON.stringify([{ transport: "https", address: ALT, priority: 10 }]),
    });
    stubFetch({ [A]: serve(a) });
    const hub = instanceEnv("hub.example", await newFedKey());
    const dns = JSON.stringify([{ transport: "https", address: A, priority: 10, verifiedVia: "ardc-lot" }]);
    await insertPeer(hub, A, {
      instance: "a.example",
      public_key: key.pub,
      trust: "unvetted",
      added_via: "44net",
      endpoints: dns,
      endpoints_source: "dns",
    });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await peerRow(hub, A)).toMatchObject({ endpoints: dns, endpoints_source: "dns" });
  });

  it("corroboration asks the peer at the addresses a sync uses", async () => {
    const key = await newFedKey();
    const LOGGER = "OE8LOG";
    const p = instanceEnv("p.example", key, {
      FIRST_PARTY_SITES: "OE8XXX",
      FED_ENDPOINTS: JSON.stringify([{ transport: "https", address: ALT, priority: 10 }]),
    });
    await p.DB.prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport) VALUES (?, ?, 47.07, 15.44, 'rf', 'OE8XXX', 'WIDE1-1', 'aprs', 'tnc')",
    )
      .bind(LOGGER, nowS() - 600)
      .run();
    const routes = stubFetch({ [A]: serve(p), [ALT]: serve(p) });
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_CORROBORATION_QUORUM: "1" });
    await insertPeer(hub, A, {
      instance: "p.example",
      public_key: key.pub,
      accept_keys: JSON.stringify([{ x: key.pub }]),
      trust: "trusted",
      added_via: "manual",
    });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    delete routes[A]; // only the address the descriptor lists answers now
    const q = { callsign: LOGGER, lat: 47.07, lon: 15.44, radiusM: 150, since: nowS() - 1800, until: nowS() };
    expect((await queryPeerCorroboration(hub, q))?.instance).toBe("p.example");
  });

  it("a beacon merges into the stored set and keeps what DNS attested", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key);
    const hub = instanceEnv("hub.example", await newFedKey());
    const HOST = "aprscaching.oe8apr.ampr.org";
    await insertPeer(hub, `http://${HOST}`, {
      instance: "a.example",
      public_key: key.pub,
      trust: "unvetted",
      added_via: "44net",
      endpoints: JSON.stringify([
        { transport: "44net", address: HOST, priority: 10, verifiedVia: "ardc-lot" },
        { transport: "https", address: "https://old.a.example", priority: 30 },
      ]),
      endpoints_source: "dns",
    });
    const announce = async (body: Record<string, unknown>, at: number) =>
      (await signFedRecord(a, {
        kind: "peer",
        gid: "a.example:peer:announce",
        origin: "a.example",
        v: at,
        at,
        signer: "a.example",
        body,
      }))!;
    const stored = async () =>
      JSON.parse(String((await peerRow(hub, `http://${HOST}`))?.endpoints)) as Record<string, unknown>[];

    // a whole list: the old https address goes, the DNS one stays, and a claimed attestation is dropped
    const whole = [{ transport: "https", address: "https://new.a.example", priority: 20, verifiedVia: "ardc-lot" }];
    expect((await applyFedFrames(hub, [await announce({ addresses: whole }, nowS())])).applied).toBe(1);
    expect(await stored()).toEqual([
      { transport: "44net", address: HOST, priority: 10, verifiedVia: "ardc-lot" },
      { transport: "https", address: "https://new.a.example", priority: 20 },
    ]);
    // a trimmed beacon adds, and drops nothing
    const part = [{ transport: "https", address: "https://third.a.example", priority: 5 }];
    expect((await applyFedFrames(hub, [await announce({ addresses: part, partial: true }, nowS() + 1)])).applied).toBe(
      1,
    );
    expect((await stored()).map((e) => e.address)).toEqual(["https://third.a.example", HOST, "https://new.a.example"]);
    expect((await peerRow(hub, `http://${HOST}`))?.endpoints_source).toBe("dns");
  });
});

describe("trust decisions", () => {
  it("raising a peer to trusted needs the compared fingerprint, on the operator secret too", async () => {
    const key = await newFedKey();
    const hub = instanceEnv("hub.example", await newFedKey());
    await insertPeer(hub, A, { instance: "a.example", public_key: key.pub, trust: "unvetted", added_via: "admin" });
    const bare = await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "trusted" });
    expect(bare.status).toBe(400);
    expect(bare.data.error).toMatch(/fingerprint required/);
    expect((await peerRow(hub, A))?.trust).toBe("unvetted");
    expect(
      (await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "trusted", fingerprint: fp(key) })).status,
    ).toBe(200);
  });

  it("an automatic promotion keeps how the peer arrived, and an operator decision replaces it", async () => {
    const LOGGER = "OE8LOG";
    const peers: { url: string; key: FedKey; env: Env }[] = [];
    for (const name of ["p1", "p2"]) {
      const key = await newFedKey();
      const env = instanceEnv(`${name}.example`, key, { FIRST_PARTY_SITES: "OE8XXX" });
      await env.DB.prepare(
        "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport) VALUES (?, ?, 47.07, 15.44, 'rf', 'OE8XXX', 'WIDE1-1', 'aprs', 'tnc')",
      )
        .bind(LOGGER, nowS() - 600)
        .run();
      peers.push({ url: `https://${name}.example`, key, env });
    }
    stubFetch(Object.fromEntries(peers.map((p) => [p.url, serve(p.env)])));
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_CORROBORATION_QUORUM: "1", FED_AUTO_PROMOTE: "1" });
    for (const [i, p] of peers.entries())
      await insertPeer(hub, p.url, {
        instance: new URL(p.url).host,
        public_key: p.key.pub,
        accept_keys: JSON.stringify([{ x: p.key.pub }]),
        trust: i === 0 ? "trusted" : "unvetted",
        added_via: i === 0 ? "manual" : "registry",
      });
    const q = { callsign: LOGGER, lat: 47.07, lon: 15.44, radiusM: 150, since: nowS() - 1800, until: nowS() };
    expect(await queryPeerCorroboration(hub, q)).not.toBeNull();
    const promoted = await peerRow(hub, peers[1]!.url);
    expect(promoted).toMatchObject({ trust: "trusted", added_via: "registry" });
    expect(promoted?.auto_promoted_at).not.toBeNull();
    await req(hub, "POST", "/federation/peers/trust", {
      url: peers[1]!.url,
      trust: "trusted",
      fingerprint: fp(peers[1]!.key),
    });
    expect((await peerRow(hub, peers[1]!.url))?.auto_promoted_at).toBeNull();
  });
});
