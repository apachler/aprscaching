// SPDX-License-Identifier: AGPL-3.0-or-later
// Adding and removing federation peers from Instance admin, over real instances. A peer added by address
// starts unvetted with the key its sysop compared; trusting it is a separate step that needs a pinned key;
// removing it drops the key, so adding it again fetches and compares a key afresh. A FED_PEERS entry starts
// trusted only when it pins the fingerprint its key then matches.
import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import {
  newFedKey,
  instanceEnv,
  addCache,
  serve,
  stubFetch,
  peerRow,
  remoteCacheCount,
  type FedKey,
} from "./helpers/fedpeer.js";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => {
  vi.unstubAllGlobals();
});

const A = "https://a.example";
const OP = { "x-operator-secret": "test-operator-secret" };

/** The fingerprint as a peer's sysop computes it by hand: the first 16 hex digits of SHA-256 over the raw key. */
const fp = (k: FedKey) =>
  createHash("sha256")
    .update(Buffer.from(k.pub, "base64url"))
    .digest("hex")
    .slice(0, 16)
    .replace(/(.{4})(?=.)/g, "$1 ");

async function req(env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = OP) {
  const res = await serve(env)(
    new Request(`https://hub.example${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

/** A peer at A with one cache, and a hub that can reach it. */
async function setup(hubExtra: Record<string, unknown> = {}) {
  const key = await newFedKey();
  const a = instanceEnv("a.example", key);
  await addCache(a);
  const routes = stubFetch({ [A]: serve(a) });
  const hub = instanceEnv("hub.example", await newFedKey(), hubExtra);
  return { key, a, routes, hub };
}

describe("adding a peer by address", () => {
  it("looks the peer up first and stores nothing", async () => {
    const { key, hub } = await setup();
    const r = await req(hub, "POST", "/federation/peers", { url: `${A}/` });
    expect(r.status).toBe(200);
    expect(r.data.preview).toEqual({ url: A, instance: "a.example", fingerprint: fp(key), operator: null });
    expect(await peerRow(hub, A)).toBeNull();
  });

  it("adds it unvetted with the compared key pinned, never trusted", async () => {
    const { key, hub } = await setup();
    const r = await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key), trust: "trusted" });
    expect(r.status).toBe(201);
    expect(r.data.peer.trust).toBe("unvetted");
    const row = await peerRow(hub, A);
    expect(row).toMatchObject({ trust: "unvetted", instance: "a.example", public_key: key.pub, added_via: "admin" });
    expect(row?.approved_at).toBeNull();
    // an unvetted peer is mirrored, and what it publishes is not shown as trusted
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await remoteCacheCount(hub, "a.example")).toBe(1);
    expect((await peerRow(hub, A))?.trust).toBe("unvetted");
  });

  it("accepts the fingerprint as a sysop reads it: ungrouped, colons, any case", async () => {
    const { key, hub } = await setup();
    const typed = fp(key).toUpperCase().replace(/ /g, ":");
    expect((await req(hub, "POST", "/federation/peers", { url: A, fingerprint: typed })).status).toBe(201);
  });

  it("refuses a fingerprint that is not the peer's key", async () => {
    const { hub } = await setup();
    const other = await newFedKey();
    const r = await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(other) });
    expect(r.status).toBe(409);
    expect(r.data.preview.instance).toBe("a.example");
    expect(await peerRow(hub, A)).toBeNull();
  });

  it("refuses when the key changed between the look-up and the add", async () => {
    const { key, routes, hub } = await setup();
    const looked = await req(hub, "POST", "/federation/peers", { url: A });
    expect(looked.data.preview.fingerprint).toBe(fp(key));
    routes[A] = serve(instanceEnv("a.example", await newFedKey())); // another server answers on A
    expect((await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key) })).status).toBe(409);
    expect(await peerRow(hub, A)).toBeNull();
  });

  it("refuses an unsigned instance, an unreachable one, itself and a bad URL", async () => {
    stubFetch({ [A]: serve(instanceEnv("a.example", null)) });
    const hub = instanceEnv("hub.example", await newFedKey());
    expect((await req(hub, "POST", "/federation/peers", { url: A })).status).toBe(409);
    expect((await req(hub, "POST", "/federation/peers", { url: "https://gone.example" })).status).toBe(502);
    expect((await req(hub, "POST", "/federation/peers", { url: "ftp://a.example" })).status).toBe(400);
    expect((await req(hub, "POST", "/federation/peers", { url: "https://u:p@a.example" })).status).toBe(400);
    stubFetch({ "https://hub.example": serve(hub) });
    expect((await req(hub, "POST", "/federation/peers", { url: "https://hub.example" })).status).toBe(400);
  });

  it("refuses a second address for an instance it already knows, and a blocked instance", async () => {
    const { key, a, routes, hub } = await setup();
    await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key) });
    routes["https://a2.example"] = serve(a);
    const again = await req(hub, "POST", "/federation/peers", { url: "https://a2.example", fingerprint: fp(key) });
    expect(again.status).toBe(409);
    expect(again.data.error).toMatch(/already a peer at https:\/\/a\.example/);
    await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "blocked" });
    const blocked = await req(hub, "POST", "/federation/peers", { url: "https://a2.example", fingerprint: fp(key) });
    expect(blocked.status).toBe(409);
    expect(blocked.data.error).toMatch(/blocked/);
  });
});

describe("raising a peer to trusted", () => {
  it("trusts it when the compared fingerprint is the pinned key's", async () => {
    const { key, hub } = await setup();
    await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key) });
    const other = await newFedKey();
    const wrong = await req(hub, "POST", "/federation/peers/trust", {
      url: A,
      trust: "trusted",
      fingerprint: fp(other),
    });
    expect(wrong.status).toBe(409);
    expect((await peerRow(hub, A))?.trust).toBe("unvetted");
    const ok = await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "trusted", fingerprint: fp(key) });
    expect(ok.status).toBe(200);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "trusted" });
    expect((await peerRow(hub, A))?.approved_at).not.toBeNull();
  });

  it("refuses to trust a peer with no pinned key", async () => {
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, trust, added_via, enabled) VALUES ('https://found.example', 'unvetted', 'discovered', 0)",
    ).run();
    const r = await req(hub, "POST", "/federation/peers/trust", { url: "https://found.example", trust: "trusted" });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/no key is pinned/);
  });

  it("lists each peer's fingerprint and this instance's own", async () => {
    const { key, hub } = await setup();
    await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key) });
    const r = await req(hub, "GET", "/federation/peers");
    expect(r.data.self.instance).toBe("hub.example");
    expect(r.data.self.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    const p = r.data.peers.find((x: { url: string }) => x.url === A);
    expect(p).toMatchObject({ fingerprint: fp(key), configured: false, trust: "unvetted" });
    expect(p.public_key).toBeUndefined();
  });
});

describe("removing a peer", () => {
  it("drops the peer and its key; what it published stays, from an unknown origin", async () => {
    const { key, hub } = await setup();
    await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key) });
    await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "trusted", fingerprint: fp(key) });
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(1);
    const before = await req(hub, "GET", "/api/caches?bbox=15,47,16,48");
    expect(before.data.caches.some((c: { origin?: string }) => c.origin === "a.example")).toBe(true);
    const r = await req(hub, "DELETE", `/federation/peers?url=${encodeURIComponent(A)}`);
    expect(r.status).toBe(200);
    expect(await peerRow(hub, A)).toBeNull();
    expect(await remoteCacheCount(hub, "a.example")).toBe(1);
    // with no peer row, the cache counts as unvetted: off the map unless unvetted peers are included
    const map = await req(hub, "GET", "/api/caches?bbox=15,47,16,48");
    expect(map.data.caches.some((c: { origin?: string }) => c.origin === "a.example")).toBe(false);
    const all = await req(hub, "GET", "/api/caches?bbox=15,47,16,48&includeUnvetted=1");
    expect(all.data.caches.some((c: { origin?: string }) => c.origin === "a.example")).toBe(true);
    expect((await req(hub, "DELETE", `/federation/peers?url=${encodeURIComponent(A)}`)).status).toBe(404);
  });

  it("re-adding a removed peer starts unvetted and checks its key afresh", async () => {
    const { key, routes, hub } = await setup();
    await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key) });
    await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "trusted", fingerprint: fp(key) });
    await syncAllPeers(hub);
    await req(hub, "DELETE", `/federation/peers?url=${encodeURIComponent(A)}`);
    // the peer comes back with a new key and no rotation proof: a look-up shows the new fingerprint
    const key2 = await newFedKey();
    const a2 = instanceEnv("a.example", key2);
    await addCache(a2);
    routes[A] = serve(a2);
    const looked = await req(hub, "POST", "/federation/peers", { url: A });
    expect(looked.data.preview.fingerprint).toBe(fp(key2));
    expect((await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key) })).status).toBe(409);
    const added = await req(hub, "POST", "/federation/peers", { url: A, fingerprint: fp(key2) });
    expect(added.status).toBe(201);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "unvetted", public_key: key2.pub, approved_at: null });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
  });

  it("refuses to remove a peer FED_PEERS lists", async () => {
    const { hub } = await setup({ FED_PEERS: A });
    await req(hub, "GET", "/federation/peers"); // seeds it
    const r = await req(hub, "DELETE", `/federation/peers?url=${encodeURIComponent(A)}`);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/FED_PEERS/);
    expect(await peerRow(hub, A)).not.toBeNull();
  });
});

describe("FED_PEERS seeding", () => {
  it("seeds an entry without a fingerprint as unvetted, and syncing does not trust it", async () => {
    const { hub } = await setup({ FED_PEERS: A });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "unvetted", added_via: "manual", instance: "a.example" });
  });

  it("starts an entry trusted once its key matches the pinned fingerprint", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key);
    await addCache(a);
    stubFetch({ [A]: serve(a) });
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_PEERS: `${A}/#${fp(key).replace(/ /g, "")}` });
    const listed = await req(hub, "GET", "/federation/peers");
    expect(listed.data.peers[0]).toMatchObject({
      url: A,
      trust: "unvetted",
      pinned_fingerprint: fp(key),
      configured: true,
    });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "trusted", public_key: key.pub });
    expect(await remoteCacheCount(hub, "a.example")).toBe(1);
    // a level the operator sets afterwards holds across re-seeding and syncing
    await req(hub, "POST", "/federation/peers/trust", { url: A, trust: "unvetted" });
    await syncAllPeers(hub);
    expect((await peerRow(hub, A))?.trust).toBe("unvetted");
  });

  it("refuses a peer whose key does not match the pinned fingerprint", async () => {
    const { hub } = await setup({ FED_PEERS: `${A}#${"ab".repeat(8)}` });
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/fingerprint pinned in FED_PEERS/);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "unvetted", instance: null, public_key: null });
    expect(await remoteCacheCount(hub, "a.example")).toBe(0);
  });

  it("seeds an entry whose suffix is not a fingerprint unpinned", async () => {
    const { hub } = await setup({ FED_PEERS: `${A}#nope` });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncAllPeers(hub);
    expect(await peerRow(hub, A)).toMatchObject({ trust: "unvetted", pinned_fingerprint: null });
  });

  it("publishes the FED_PEERS URLs in the descriptor without their fingerprints", async () => {
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_PEERS: `${A}#${"ab".repeat(8)}` });
    const wk = await req(hub, "GET", "/.well-known/aprscaching");
    expect(wk.data.peers).toEqual([A]);
  });
});

describe("the peer endpoints are sysop-only", () => {
  it("answers 403 to a signed-in member and to nobody signed in", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const member = await emailSignup(env, "member@example.org", "OE8MEM");
    expect(member.cookie).not.toBe("");
    for (const cookie of [member.cookie, ""]) {
      const h: Record<string, string> = cookie ? { cookie } : {};
      expect((await call(env, "POST", "/federation/peers", { url: A }, h)).status).toBe(403);
      expect((await call(env, "DELETE", `/federation/peers?url=${encodeURIComponent(A)}`, undefined, h)).status).toBe(
        403,
      );
      expect((await call(env, "POST", "/federation/peers/trust", { url: A, trust: "trusted" }, h)).status).toBe(403);
      expect((await call(env, "GET", "/federation/peers", undefined, h)).status).toBe(403);
    }
  });
});
