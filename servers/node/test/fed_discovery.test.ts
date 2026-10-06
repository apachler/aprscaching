// SPDX-License-Identifier: AGPL-3.0-or-later
// Discovery over real instances: a ⇄ hub ⇄ b, where b follows only the hub. The hub lists the instances it
// trusts (peer exchange); b learns them from a trusted hub only, lists each switched off and unvetted, pulls
// nothing from it, and follows, trusts or blocks it on the sysop's word. A listed key never replaces a pinned
// one, the table stays bounded, sightings expire, a discovered row and a hub's `transit:` row for one instance
// stay one row, and an instance announced on the local network is reachable at that address alone.
import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { expireDiscovered, lanOriginAllowed, learnListing, recordLanSighting } from "@aprscaching/gateway/feddiscover";
import { call } from "./helpers/authflow.js";
import { makeFetchGuard } from "../src/fetchguard.js";
import { addCache, instanceEnv, newFedKey, serve, stubFetch, type FedKey, type Serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const OP = { "x-operator-secret": "test-operator-secret" };
const A = "https://a.example";
const HUB = "https://hub.example";
const now = () => Math.floor(Date.now() / 1000);
const fp = (k: FedKey) =>
  createHash("sha256")
    .update(Buffer.from(k.pub, "base64url"))
    .digest("hex")
    .slice(0, 16)
    .replace(/(.{4})(?=.)/g, "$1 ");

async function follow(env: Env, url: string, instance: string, key: FedKey, trust = "trusted") {
  await env.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, ?, ?, ?, ?, 'manual')",
  )
    .bind(url, instance, key.pub, JSON.stringify([{ x: key.pub }]), trust)
    .run();
}

const one = async (env: Env, sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<Record<string, unknown>>()) ?? null;
const count = async (env: Env, sql: string, ...binds: unknown[]) => Number((await one(env, sql, ...binds))!.n);

/** Serve `inner`, with the peer list rewritten by `patch`. */
const withExchange =
  (inner: Serve, patch: (peers: Record<string, unknown>[]) => Record<string, unknown>[]): Serve =>
  async (req) => {
    const res = await inner(req);
    if (new URL(req.url).pathname !== "/federation/exchange") return res;
    const doc = (await res.json()) as { instance: string; peers: Record<string, unknown>[] };
    return Response.json({ ...doc, peers: patch(doc.peers) });
  };

/**
 * `a` with a cache; the hub trusting `a`; `b` trusting the hub, with discovery on. `aHits` counts the requests
 * that reach `a`.
 */
async function world(opts: { bEnv?: Record<string, unknown>; hubEnv?: Record<string, unknown> } = {}) {
  const ka = await newFedKey(),
    kh = await newFedKey(),
    kb = await newFedKey();
  const a = instanceEnv("a.example", ka);
  const hub = instanceEnv("hub.example", kh, opts.hubEnv);
  const b = instanceEnv("b.example", kb, { FED_DISCOVER: "1", ...opts.bEnv });
  await follow(hub, A, "a.example", ka);
  await follow(b, HUB, "hub.example", kh);
  await addCache(a, now() - 60);
  const aHits: string[] = [];
  const serveA = serve(a);
  const routes = stubFetch({
    [A]: (req) => {
      aHits.push(new URL(req.url).pathname);
      return serveA(req);
    },
    [HUB]: serve(hub),
  });
  return { a, hub, b, ka, kh, kb, routes, aHits };
}

const peersOf = async (env: Env) =>
  (await call(env, "GET", "/federation/peers", undefined, OP)).data.peers as Array<Record<string, any>>;

describe("peer exchange", () => {
  it("lists only the instances this one trusts, with fingerprint and addresses", async () => {
    const { hub, ka } = await world();
    const ky = await newFedKey(),
      kz = await newFedKey(),
      kl = await newFedKey();
    await follow(hub, "https://y.example", "y.example", ky, "unvetted");
    await follow(hub, "https://z.example", "z.example", kz, "blocked");
    await follow(hub, "http://192.168.1.9:8787", "lan.example", kl); // a LAN address means nothing to a peer
    const r = await call(hub, "GET", "/federation/exchange");
    expect(r.status).toBe(200);
    expect(r.data.peers).toEqual([
      { instance: "a.example", fingerprint: fp(ka), addresses: [{ transport: "https", address: A, priority: 100 }] },
    ]);
    const wk = await call(hub, "GET", "/.well-known/aprscaching");
    expect(wk.data.capabilities).toContain("peer-exchange");
    expect(wk.data.endpoints.exchange).toBe("/federation/exchange");
    expect(wk.data.peers).toBeUndefined();
  });

  it("FED_PEER_EXCHANGE=0 serves no list, and the instance setting turns it off too", async () => {
    const env = instanceEnv("hub.example", await newFedKey(), { FED_PEER_EXCHANGE: "0" });
    expect((await call(env, "GET", "/federation/exchange")).status).toBe(404);
    expect((await call(env, "GET", "/.well-known/aprscaching")).data.capabilities).not.toContain("peer-exchange");

    const site = instanceEnv("hub2.example", await newFedKey());
    expect((await call(site, "GET", "/federation/exchange")).status).toBe(200);
    expect((await call(site, "PUT", "/api/admin/settings/FED_PEER_EXCHANGE", { value: "0" }, OP)).status).toBe(200);
    expect((await call(site, "GET", "/federation/exchange")).status).toBe(404);
  });

  it("a hub that lists no peers teaches b nothing", async () => {
    const { b } = await world({ hubEnv: { FED_PEER_EXCHANGE: "0" } });
    await syncAllPeers(b);
    expect(await count(b, "SELECT COUNT(*) AS n FROM fed_peers WHERE instance = 'a.example'")).toBe(0);
  });
});

describe("what b learns", () => {
  it("lists a trusted peer's instances switched off and unvetted, and pulls nothing from them", async () => {
    const { b, ka, aHits } = await world({ hubEnv: { FED_RESERVE: "off" } });
    await syncAllPeers(b);
    const row = await one(b, "SELECT * FROM fed_peers WHERE instance = 'a.example'");
    expect(row).toMatchObject({
      url: "discovered:a.example",
      trust: "unvetted",
      enabled: 0,
      added_via: "discovered",
      public_key: null,
    });
    expect(JSON.parse(row!.endpoints as string)).toEqual([{ transport: "https", address: A, priority: 100 }]);
    expect(JSON.parse(row!.discovered as string)).toEqual([
      expect.objectContaining({ via: "hub.example", fp: fp(ka) }),
    ]);
    await syncAllPeers(b);
    expect(aHits).toEqual([]);
    expect(await count(b, "SELECT COUNT(*) AS n FROM remote_caches WHERE origin = 'a.example'")).toBe(0);
    const listed = (await peersOf(b)).find((p) => p.instance === "a.example")!;
    expect(listed.discovery).toMatchObject({ keyMismatch: false, onThisNetwork: false, addresses: [A] });
  });

  it("learns nothing from an unvetted peer, nor with FED_DISCOVER off", async () => {
    const w = await world();
    await w.b.DB.prepare("UPDATE fed_peers SET trust = 'unvetted' WHERE url = ?").bind(HUB).run();
    await syncAllPeers(w.b);
    expect(await count(w.b, "SELECT COUNT(*) AS n FROM fed_peers WHERE instance = 'a.example'")).toBe(0);

    const off = await world({ bEnv: { FED_DISCOVER: "0" } });
    await syncAllPeers(off.b);
    expect(await count(off.b, "SELECT COUNT(*) AS n FROM fed_peers WHERE instance = 'a.example'")).toBe(0);
  });

  it("skips an instance blocked here, itself, the listing peer, and entries without a public address", async () => {
    const { b, kb } = await world();
    await follow(b, "https://old-a.example", "a.example", await newFedKey(), "blocked");
    await learnListing(b, "hub.example", [
      { instance: "b.example", fingerprint: fp(kb), addresses: [{ transport: "https", address: "https://b.example" }] },
      { instance: "hub.example", fingerprint: fp(kb), addresses: [{ transport: "https", address: HUB }] },
      { instance: "lan.example", fingerprint: fp(kb), addresses: [{ transport: "hamnet", address: "192.168.1.9" }] },
      { instance: "nofp.example", addresses: [{ transport: "https", address: "https://nofp.example" }] },
      { instance: "a.example", fingerprint: fp(kb), addresses: [{ transport: "https", address: A }] },
    ]);
    expect(await count(b, "SELECT COUNT(*) AS n FROM fed_peers WHERE url LIKE 'discovered:%'")).toBe(0);
    expect(await one(b, "SELECT trust FROM fed_peers WHERE instance = 'a.example'")).toEqual({ trust: "blocked" });
  });

  it("caps the discovered rows and expires sightings no trusted peer renews", async () => {
    const { b, ka } = await world();
    const many = Array.from({ length: 250 }, (_, i) => ({
      instance: `p${i}.example`,
      fingerprint: fp(ka),
      addresses: [{ transport: "https", address: `https://p${i}.example` }],
    }));
    await learnListing(b, "hub.example", many);
    await learnListing(b, "hub.example", many);
    expect(await count(b, "SELECT COUNT(*) AS n FROM fed_peers WHERE url LIKE 'discovered:%'")).toBe(200);

    // fresh sightings stay; one past its lifetime, or from a peer no longer trusted, goes with its row
    expect(await expireDiscovered(b)).toBe(0);
    const old = JSON.stringify([{ via: "hub.example", fp: fp(ka), at: now() - 15 * 86400 }]);
    await b.DB.prepare("UPDATE fed_peers SET discovered = ? WHERE url = 'discovered:p0.example'").bind(old).run();
    await b.DB.prepare("UPDATE fed_peers SET discovered = ? WHERE url = 'discovered:p1.example'")
      .bind(JSON.stringify([{ via: "stranger.example", fp: fp(ka), at: now() }]))
      .run();
    expect(await expireDiscovered(b)).toBe(2);
    expect(await count(b, "SELECT COUNT(*) AS n FROM fed_peers WHERE url LIKE 'discovered:%'")).toBe(198);
    // a peer the sysop demotes stops vouching for every sighting it gave
    await b.DB.prepare("UPDATE fed_peers SET trust = 'unvetted' WHERE url = ?").bind(HUB).run();
    await expireDiscovered(b);
    expect(await count(b, "SELECT COUNT(*) AS n FROM fed_peers WHERE url LIKE 'discovered:%'")).toBe(0);
  });
});

describe("the sysop's actions", () => {
  it("Follow pins the key that answers, enables the row and pulls from it, unvetted", async () => {
    const { b, ka } = await world({ hubEnv: { FED_RESERVE: "off" } });
    await syncAllPeers(b);
    const r = await call(b, "POST", "/federation/peers/follow", { url: "discovered:a.example" }, OP);
    expect(r.status).toBe(200);
    expect(r.data.peer).toMatchObject({ url: A, instance: "a.example", fingerprint: fp(ka), trust: "unvetted" });
    expect(
      await one(b, "SELECT url, trust, enabled, public_key, added_via FROM fed_peers WHERE instance = 'a.example'"),
    ).toEqual({ url: A, trust: "unvetted", enabled: 1, public_key: ka.pub, added_via: "discovered" });
    await syncAllPeers(b);
    expect(await count(b, "SELECT COUNT(*) AS n FROM remote_caches WHERE origin = 'a.example'")).toBe(1);
  });

  it("Trust needs the compared fingerprint, then trusts it at once", async () => {
    const { b, ka } = await world();
    await syncAllPeers(b);
    const url = "discovered:a.example";
    expect((await call(b, "POST", "/federation/peers/follow", { url, trust: true }, OP)).status).toBe(400);
    const wrong = await call(
      b,
      "POST",
      "/federation/peers/follow",
      { url, trust: true, fingerprint: "ab".repeat(8) },
      OP,
    );
    expect(wrong.status).toBe(409);
    expect(await one(b, "SELECT url, enabled FROM fed_peers WHERE instance = 'a.example'")).toEqual({
      url,
      enabled: 0,
    });
    // the trust endpoint does not bypass Follow for a discovered row
    expect((await call(b, "POST", "/federation/peers/trust", { url, trust: "unvetted" }, OP)).status).toBe(409);
    const ok = await call(b, "POST", "/federation/peers/follow", { url, trust: true, fingerprint: fp(ka) }, OP);
    expect(ok.status).toBe(200);
    expect(await one(b, "SELECT trust, enabled FROM fed_peers WHERE url = ?", A)).toEqual({
      trust: "trusted",
      enabled: 1,
    });
  });

  it("Block keeps it blocked: no listing brings it back or lifts it", async () => {
    const { b } = await world();
    await syncAllPeers(b);
    const url = "discovered:a.example";
    expect((await call(b, "POST", "/federation/peers/trust", { url, trust: "blocked" }, OP)).status).toBe(200);
    await b.DB.prepare("UPDATE fed_peers SET discovered = NULL WHERE url = ?").bind(url).run();
    await syncAllPeers(b); // the hub lists it again
    expect(await one(b, "SELECT trust, enabled, discovered FROM fed_peers WHERE instance = 'a.example'")).toEqual({
      trust: "blocked",
      enabled: 0,
      discovered: null,
    });
    expect((await call(b, "POST", "/federation/peers/follow", { url }, OP)).status).toBe(409);
    expect(await expireDiscovered(b)).toBe(0); // a block is the sysop's, never expired
  });

  it("an instance added by its address absorbs its discovered row", async () => {
    const { b, ka } = await world();
    await syncAllPeers(b);
    const add = await call(b, "POST", "/federation/peers", { url: A, fingerprint: fp(ka) }, OP);
    expect(add.status).toBe(201);
    expect(await count(b, "SELECT COUNT(*) AS n FROM fed_peers WHERE instance = 'a.example'")).toBe(1);
    expect(await one(b, "SELECT url, added_via FROM fed_peers WHERE instance = 'a.example'")).toEqual({
      url: A,
      added_via: "admin",
    });
  });
});

describe("a listed key never replaces a pinned one", () => {
  it("a mismatch on a followed peer is flagged and the pin stays", async () => {
    const { b, routes, hub } = await world();
    const ka2 = await newFedKey();
    await follow(b, A, "a.example", (await newFedKey()) as FedKey, "unvetted");
    const pinned = (await one(b, "SELECT public_key FROM fed_peers WHERE url = ?", A))!.public_key;
    routes[HUB] = withExchange(serve(hub), (peers) => peers.map((p) => ({ ...p, fingerprint: fp(ka2) })));
    await learnListing(b, "hub.example", [
      { instance: "a.example", fingerprint: fp(ka2), addresses: [{ transport: "https", address: A }] },
    ]);
    expect(await one(b, "SELECT public_key FROM fed_peers WHERE url = ?", A)).toEqual({ public_key: pinned });
    const row = (await peersOf(b)).find((p) => p.instance === "a.example")!;
    expect(row.discovery.keyMismatch).toBe(true);
  });

  it("Follow refuses a key other than the listed fingerprint", async () => {
    const { b, routes, hub } = await world();
    const other = await newFedKey();
    routes[HUB] = withExchange(serve(hub), (peers) => peers.map((p) => ({ ...p, fingerprint: fp(other) })));
    await syncAllPeers(b);
    const r = await call(b, "POST", "/federation/peers/follow", { url: "discovered:a.example" }, OP);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/hub\.example listed/);
    expect(await one(b, "SELECT url, public_key, enabled FROM fed_peers WHERE instance = 'a.example'")).toEqual({
      url: "discovered:a.example",
      public_key: null,
      enabled: 0,
    });
  });
});

describe("a discovered row and a transit row are one row", () => {
  it("an instance both listed and passed on through the hub keeps one transit row with its sighting", async () => {
    const { b, hub, ka } = await world(); // the hub passes a's records on (FED_RESERVE trusted)
    await syncAllPeers(hub);
    await syncAllPeers(b);
    expect(await count(b, "SELECT COUNT(*) AS n FROM fed_peers WHERE instance = 'a.example'")).toBe(1);
    const row = await one(b, "SELECT * FROM fed_peers WHERE instance = 'a.example'");
    expect(row).toMatchObject({ url: "transit:a.example", added_via: "transit", enabled: 0, public_key: ka.pub });
    expect(JSON.parse(row!.discovered as string)[0]).toMatchObject({ via: "hub.example", fp: fp(ka) });
    // Follow takes the transit row over at its learned address, under the key the hub handed on
    const r = await call(b, "POST", "/federation/peers/follow", { url: "transit:a.example" }, OP);
    expect(r.status).toBe(200);
    expect(await one(b, "SELECT url, enabled, public_key FROM fed_peers WHERE instance = 'a.example'")).toEqual({
      url: A,
      enabled: 1,
      public_key: ka.pub,
    });
  });

  it("a transit row learned first takes the later sighting", async () => {
    const w = await world({ bEnv: { FED_DISCOVER: "0" } });
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(await one(w.b, "SELECT url, discovered FROM fed_peers WHERE instance = 'a.example'")).toEqual({
      url: "transit:a.example",
      discovered: null,
    });
    w.b.FED_DISCOVER = "1";
    await syncAllPeers(w.b);
    expect(await count(w.b, "SELECT COUNT(*) AS n FROM fed_peers WHERE instance = 'a.example'")).toBe(1);
    const row = await one(w.b, "SELECT url, discovered, endpoints FROM fed_peers WHERE instance = 'a.example'");
    expect(row!.url).toBe("transit:a.example");
    expect(JSON.parse(row!.discovered as string)[0]).toMatchObject({ via: "hub.example" });
    expect(JSON.parse(row!.endpoints as string)[0]).toMatchObject({ transport: "https", address: A });
  });
});

describe("an instance on the local network (mDNS)", () => {
  it("is listed on this network, reachable at the announced address only, and followed there", async () => {
    const kl = await newFedKey();
    const lan = instanceEnv("lan.example", kl);
    const b = instanceEnv("b.example", await newFedKey());
    const LAN = "http://192.168.43.7:8787";
    stubFetch({ [LAN]: serve(lan) });
    expect(
      await recordLanSighting(b, { instance: "lan.example", fingerprint: fp(kl).replace(/ /g, ""), address: LAN }),
    ).toBe(true);
    expect(await recordLanSighting(b, { instance: "b.example", fingerprint: fp(kl), address: LAN })).toBe(false);
    const listed = (await peersOf(b)).find((p) => p.instance === "lan.example")!;
    expect(listed).toMatchObject({ enabled: 0, trust: "unvetted", url: "discovered:lan.example" });
    expect(listed.discovery).toMatchObject({ onThisNetwork: true, addresses: [LAN] });

    expect(await lanOriginAllowed(b, LAN)).toBe(true);
    expect(await lanOriginAllowed(b, "http://192.168.43.1")).toBe(false);
    const guard = makeFetchGuard({ allowLocalOrigin: (o) => lanOriginAllowed(b, o) });
    await expect(guard(`${LAN}/.well-known/aprscaching`)).resolves.toBeUndefined();
    await expect(guard("http://192.168.43.1/")).rejects.toThrow(/private/);

    const r = await call(b, "POST", "/federation/peers/follow", { url: "discovered:lan.example" }, OP);
    expect(r.status).toBe(200);
    expect(await one(b, "SELECT url, added_via, enabled FROM fed_peers WHERE instance = 'lan.example'")).toEqual({
      url: LAN,
      added_via: "mdns",
      enabled: 1,
    });
    // the followed peer stays reachable after its announcement expires
    await b.DB.prepare("UPDATE fed_peers SET discovered = NULL WHERE url = ?").bind(LAN).run();
    expect(await lanOriginAllowed(b, LAN)).toBe(true);
    await b.DB.prepare("UPDATE fed_peers SET trust = 'blocked' WHERE url = ?").bind(LAN).run();
    expect(await lanOriginAllowed(b, LAN)).toBe(false);
  });
});
