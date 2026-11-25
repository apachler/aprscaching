// SPDX-License-Identifier: AGPL-3.0-or-later
// Who may bind a peer's key. A neighbour hands on keys for the origins it passes on only when this instance trusts
// it: an unvetted peer's summary pins nothing, so it can neither plant a key the origin's genuine frames then fail
// under nor take room in the transit-origin cap. A 44Net add is held to the registry's key binding before any
// confirm, as an add by address is. Relay authentication reads the same key set, so it refuses what these refuse.
import { describe, it, expect, afterEach, vi } from "vitest";
import { handle } from "@aprscaching/gateway/app";
import { applyFedFrames, keysForOrigin, syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { signRelayRequest, spokeAuth } from "@aprscaching/gateway/relay";
import type { Env } from "@aprscaching/gateway/env";
import {
  addCache,
  gid,
  instanceEnv,
  newFedKey,
  serve,
  servedFrames,
  signedRegistry,
  stubFetch,
  type FedKey,
  type Serve,
} from "./helpers/fedpeer.js";

afterEach(() => vi.unstubAllGlobals());
const now = () => Math.floor(Date.now() / 1000);

const addPeer = (env: Env, instance: string, key: string, trust: string) =>
  env.DB.prepare("INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, ?, ?, ?, 'manual')")
    .bind(`https://${instance}`, instance, key, trust)
    .run();

/** Does `env` take a relay request that `signer` signed while claiming to be `instance`? */
async function relayAccepts(env: Env, instance: string, signer: FedKey): Promise<boolean> {
  const url = "https://b.example/federation/relay/lease";
  const headers = await signRelayRequest(instanceEnv(instance, signer), "POST", url);
  return spokeAuth(new Request(url, { method: "POST", headers: headers! }), env, instance, new Uint8Array(0));
}

/** A ⇄ hub (trusted at B) ⇄ B, and a peer B pulls first whose summary names a.example under its own key. */
async function transitWorld(claimantTrust: "unvetted" | "trusted") {
  const ka = await newFedKey(),
    kh = await newFedKey(),
    kb = await newFedKey(),
    ke = await newFedKey();
  const a = instanceEnv("a.example", ka),
    hub = instanceEnv("hub.example", kh),
    b = instanceEnv("b.example", kb),
    evil = instanceEnv("evil.example", ke);
  await addPeer(hub, "a.example", ka.pub, "trusted");
  await addPeer(b, "evil.example", ke.pub, claimantTrust);
  await addPeer(b, "hub.example", kh.pub, "trusted");
  const cg = await gid(a, "cache", await addCache(a, now() - 60));
  const evilServe: Serve = async (req) => {
    if (new URL(req.url).pathname === "/federation/sync/summary")
      return Response.json({
        instance: "evil.example",
        complete: true,
        origins: [
          { origin: "a.example", held: {}, top: {}, publicKey: ke.pub, publicKeys: [{ x: ke.pub }], rotations: [] },
          { origin: "evil.example", held: {}, top: {} },
        ],
      });
    return serve(evil)(req);
  };
  stubFetch({ "https://a.example": serve(a), "https://hub.example": serve(hub), "https://evil.example": evilServe });
  await syncAllPeers(hub);
  await syncAllPeers(b);
  await syncAllPeers(b);
  const row = await b.DB.prepare("SELECT public_key FROM fed_peers WHERE instance = 'a.example'").first<{
    public_key: string;
  }>();
  const mirrored = await b.DB.prepare("SELECT origin FROM remote_caches WHERE global_id = ?").bind(cg).first();
  return { b, ka, ke, row, mirrored };
}

describe("transit keys come only from a trusted neighbour", () => {
  it("an unvetted peer's key for another origin pins nothing, and the origin's cache arrives through the hub", async () => {
    const w = await transitWorld("unvetted");
    expect(w.row?.public_key).toBe(w.ka.pub);
    expect(w.mirrored).toEqual({ origin: "a.example" });
  });

  it("relay authentication refuses the unvetted peer signing as that origin", async () => {
    const w = await transitWorld("unvetted");
    expect(await relayAccepts(w.b, "a.example", w.ke)).toBe(false);
    expect(await relayAccepts(w.b, "a.example", w.ka)).toBe(true);
  });

  it("a trusted neighbour still hands on the keys of the origins it passes on", async () => {
    const w = await transitWorld("trusted");
    expect(w.row?.public_key).toBe(w.ke.pub);
  });
});

describe("the transit-origin cap", () => {
  it("an unvetted peer naming 600 origins takes none of it, and a trusted hub still introduces a new origin", async () => {
    const ka = await newFedKey(),
      kh = await newFedKey(),
      kb = await newFedKey(),
      ke = await newFedKey();
    const a = instanceEnv("a.example", ka),
      hub = instanceEnv("hub.example", kh),
      b = instanceEnv("b.example", kb, { FED_DISCOVER: "0" }),
      evil = instanceEnv("evil.example", ke);
    await addPeer(hub, "a.example", ka.pub, "trusted");
    await addPeer(b, "evil.example", ke.pub, "unvetted");
    const cg = await gid(a, "cache", await addCache(a, now() - 60));
    const fakes = Array.from({ length: 600 }, (_, i) => ({
      origin: `f${String(i).padStart(4, "0")}.junk`,
      held: {},
      top: {},
      publicKey: ke.pub,
    }));
    const evilServe: Serve = async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/federation/sync/summary") {
        const after = u.searchParams.get("after") ?? "";
        const page = fakes.filter((f) => f.origin > after).slice(0, 100);
        return Response.json({
          instance: "evil.example",
          complete: page.length < 100,
          ...(page.length === 100 && { next: page[99]!.origin }),
          origins: page,
        });
      }
      if (u.pathname === "/federation/sync/origin") return new Response("no", { status: 404 });
      return serve(evil)(req);
    };
    stubFetch({ "https://a.example": serve(a), "https://hub.example": serve(hub), "https://evil.example": evilServe });
    const transitRows = async () =>
      (await b.DB.prepare("SELECT COUNT(*) AS n FROM fed_peers WHERE added_via = 'transit'").first<{ n: number }>())!.n;
    for (let i = 0; i < 11; i++) await syncAllPeers(b);
    expect(await transitRows()).toBe(0);
    await addPeer(b, "hub.example", kh.pub, "trusted");
    await syncAllPeers(hub);
    await syncAllPeers(b);
    expect(await transitRows()).toBe(1);
    expect(await b.DB.prepare("SELECT origin FROM remote_caches WHERE global_id = ?").bind(cg).first()).toEqual({
      origin: "a.example",
    });
  });
});

describe("a 44Net add is held to the registry's key binding", () => {
  async function add44net(ad: boolean, keyFor: (kv: FedKey, ke: FedKey) => string, body: Record<string, unknown> = {}) {
    const auth = await newFedKey(),
      kv = await newFedKey(),
      ke = await newFedKey(),
      kb = await newFedKey();
    const reg = await signedRegistry(auth, now(), [{ instance: "victim.example", key: kv.pub }]);
    const b = instanceEnv("b.example", kb, {
      FED_REGISTRY: JSON.stringify(reg),
      FED_REGISTRY_KEY: auth.pub,
      DOH_URL: "https://dns.example/dns-query",
    });
    const txt = `v=acs1; inst=victim.example; key=${keyFor(kv, ke)}`;
    stubFetch({
      "https://dns.example": async () =>
        Response.json({
          Status: 0,
          AD: ad,
          Answer: [{ name: "_aprscaching.n0call.ampr.org", type: 16, data: `"${txt}"` }],
        }),
    });
    const res = await handle(
      new Request("https://b.example/federation/peers/44net", {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-secret": "test-operator-secret" },
        body: JSON.stringify({ callsign: "N0CALL", ...body }),
      }),
      b,
      { waitUntil: () => {} },
    );
    return { b, kv, ke, status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("a DNSSEC-validated binding naming a registry-bound instance under another key is refused and pins nothing", async () => {
    const r = await add44net(true, (_kv, ke) => ke.pub);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/registry does not bind/);
    expect(await keysForOrigin(r.b, "victim.example")).toEqual([r.kv.pub]);
    const imp = instanceEnv("victim.example", r.ke);
    await addCache(imp, now() - 60);
    expect((await applyFedFrames(r.b, await servedFrames(imp, "cache"))).applied).toBe(0);
    expect(await relayAccepts(r.b, "victim.example", r.ke)).toBe(false);
  });

  it("without DNSSEC the refusal comes before the confirm answer, and a confirm does not pass it", async () => {
    const r = await add44net(false, (_kv, ke) => ke.pub);
    expect(r.status).toBe(409);
    expect(r.body.requiresConfirm).toBeUndefined();
    const c = await add44net(false, (_kv, ke) => ke.pub, { confirm: true });
    expect(c.status).toBe(409);
  });

  it("an invalid instance id is refused before the confirm answer", async () => {
    const auth = await newFedKey(),
      kb = await newFedKey();
    const b = instanceEnv("b.example", kb, {
      FED_REGISTRY: JSON.stringify(await signedRegistry(auth, now(), [])),
      FED_REGISTRY_KEY: auth.pub,
      DOH_URL: "https://dns.example/dns-query",
    });
    const txt = `v=acs1; inst=Not_An_Id; key=${kb.pub}`;
    stubFetch({
      "https://dns.example": async () =>
        Response.json({
          Status: 0,
          AD: false,
          Answer: [{ name: "_aprscaching.n0call.ampr.org", type: 16, data: `"${txt}"` }],
        }),
    });
    const res = await handle(
      new Request("https://b.example/federation/peers/44net", {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-secret": "test-operator-secret" },
        body: JSON.stringify({ callsign: "N0CALL" }),
      }),
      b,
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { requiresConfirm?: boolean }).requiresConfirm).toBeUndefined();
  });

  it("the key the registry binds is admitted", async () => {
    const r = await add44net(true, (kv) => kv.pub);
    expect(r.status).toBe(201);
    expect(r.body.admitted).toBe("dnssec");
  });
});
