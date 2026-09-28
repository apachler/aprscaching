// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression tests for gaps an independent review found in the federation hardening: a predecessor
// key an attacker vouches for itself, fetch-guard bypasses through IPv6 forms and redirects, a peer's
// bulletin claiming someone else's BID, a push-only spoke that could never rotate, pulls of one peer
// racing each other, and the relay purge dropping slow store-and-forward queries.
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers, syncPeerByInstance, applyFedFrames } from "@aprscaching/gateway/federation_sync";
import { resolvePeerKeys } from "@aprscaching/gateway/federation";
import { fedFetch, createFetchGuard } from "@aprscaching/gateway/fetchguard";
import { purgeRelayQueue } from "@aprscaching/gateway/relay";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import {
  newFedKey,
  rotation,
  instanceEnv,
  addCache,
  serve,
  withDescriptor,
  stubFetch,
  servedFrames,
  peerRow,
  type Serve,
} from "./helpers/fedpeer.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const A = "https://a.example";
const nowS = () => Math.floor(Date.now() / 1000);

describe("a key only becomes a predecessor through a key we already trusted", () => {
  it("refuses a self-vouched key published beside the unchanged current key", async () => {
    const k1 = await newFedKey();
    const evil = await newFedKey();
    const a = instanceEnv("a.example", k1);
    await addCache(a);
    const routes = stubFetch({ [A]: serve(a) });
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare("INSERT INTO fed_peers (url, trust, added_via) VALUES (?, 'trusted', 'manual')").bind(A).run();
    await syncAllPeers(hub);
    // the hijacker keeps the real current key and adds its own, "rotated" to the current key
    const forged = await rotation(evil, k1, nowS());
    routes[A] = withDescriptor(serve(a), (wk) => ({
      ...wk,
      publicKeys: [{ x: k1.pub }, { x: evil.pub, until: 4e9 }],
      rotations: [forged],
    }));
    await syncAllPeers(hub);
    expect(JSON.parse(String((await peerRow(hub, A))?.accept_keys)).map((k: { x: string }) => k.x)).not.toContain(
      evil.pub,
    );
    const evilSigner = instanceEnv("a.example", evil, {}, a.DB);
    await addCache(a, 9000);
    expect((await applyFedFrames(hub, await servedFrames(evilSigner))).applied).toBe(0);
  });

  it("admits no predecessor on first contact", async () => {
    const k1 = await newFedKey();
    const k2 = await newFedKey();
    const r = await resolvePeerKeys({
      pinned: null,
      current: k2.pub,
      published: [{ x: k2.pub }, { x: k1.pub, until: nowS() + 86400 }],
      rotations: [await rotation(k1, k2, nowS())],
      prior: [],
      nowS: nowS(),
    });
    expect(r.ok && r.accept.map((k) => k.x)).toEqual([k2.pub]);
  });

  it("caps a predecessor's grace at the rotation time plus the local grace", async () => {
    const k1 = await newFedKey();
    const k2 = await newFedKey();
    const at = nowS();
    const r = await resolvePeerKeys({
      pinned: k1.pub,
      current: k2.pub,
      published: [{ x: k2.pub }, { x: k1.pub, until: at + 365 * 86400 }],
      rotations: [await rotation(k1, k2, at)],
      prior: [],
      nowS: at,
    });
    expect(r.ok && r.accept.find((k) => k.x === k1.pub)?.until).toBe(at + 7 * 86400);
  });
});

describe("the fetch guard", () => {
  const guard = createFetchGuard({ resolve: async () => ["93.184.216.34"] });
  for (const u of [
    "http://[::ffff:127.0.0.1]:8787/x",
    "http://[::ffff:a9fe:a9fe]/latest/meta-data",
    "http://[::7f00:1]/",
    "http://[64:ff9b::7f00:1]/",
  ])
    it(`refuses ${u}`, async () => {
      await expect(guard(u)).rejects.toThrow(/refused/);
    });

  it("re-checks every redirect hop", async () => {
    vi.stubGlobal("fetch", async (u: RequestInfo | URL) =>
      String(u).startsWith("https://peer.example")
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/admin" } })
        : new Response("internal"),
    );
    await expect(fedFetch({ FED_FETCH_GUARD: guard }, "https://peer.example/x")).rejects.toThrow(/refused/);
  });

  it("follows a redirect to another public address", async () => {
    vi.stubGlobal("fetch", async (u: RequestInfo | URL) =>
      String(u).startsWith("https://peer.example")
        ? new Response(null, { status: 301, headers: { location: "https://mirror.example/x" } })
        : new Response("ok"),
    );
    expect(await (await fedFetch({ FED_FETCH_GUARD: guard }, "https://peer.example/x")).text()).toBe("ok");
  });
});

describe("mirrored bulletins keep their own BIDs", () => {
  it("never lets a peer claim another instance's BID", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key);
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, 'a.example', ?, 'trusted', 'manual')",
    )
      .bind(A, key.pub)
      .run();
    const f = await signFedRecord(a, {
      kind: "bulletin",
      gid: "a.example:bulletin:5",
      origin: "a.example",
      v: nowS(),
      at: nowS(),
      signer: "a.example",
      body: { bid: "123_victim.example", fromCall: "OE8APR", toCall: "ALL", body: "squat", postedAt: nowS() },
    });
    await applyFedFrames(hub, [f!]);
    const row = await hub.DB.prepare("SELECT bid FROM bbs_messages WHERE origin = 'a.example'").first<{
      bid: string;
    }>();
    expect(row?.bid).not.toBe("123_victim.example");
  });
});

describe("a push-only spoke can rotate its key", () => {
  it("accepts a submission under a new key when the spoke sends the rotation proving it", async () => {
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_SUBMIT_SECRET: "s" });
    const k1 = await newFedKey();
    const k2 = await newFedKey();
    const spoke1 = instanceEnv("s.example", k1);
    await addCache(spoke1);
    const submit = async (spoke: ReturnType<typeof instanceEnv>, headers: Record<string, string> = {}) =>
      serve(hub)(
        new Request("https://hub.example/federation/submit", {
          method: "POST",
          headers: { "content-type": "application/cbor", "x-fed-secret": "s", ...headers },
          body: await (await serve(spoke)(new Request("https://s/federation/sync/cache?since=0"))).arrayBuffer(),
        }),
      );
    expect((await submit(spoke1)).status).toBe(200);
    const spoke2 = instanceEnv("s.example", k2, {}, spoke1.DB);
    await addCache(spoke2, 2000);
    expect((await submit(spoke2)).status).toBe(403); // a new key with no proof
    const rot = JSON.stringify([await rotation(k1, k2, nowS())]);
    expect((await submit(spoke2, { "x-fed-rotations": rot })).status).toBe(200);
  });
});

describe("one pull per peer at a time", () => {
  it("a notify during the scheduled sync never pulls the same peer concurrently", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key);
    await addCache(a);
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare("INSERT INTO fed_peers (url, trust, added_via) VALUES (?, 'trusted', 'manual')").bind(A).run();
    await syncAllPeers(hub); // bind the instance
    let inFlight = 0,
      maxInFlight = 0;
    const slow: Serve = async (req) => {
      if (new URL(req.url).pathname === "/.well-known/aprscaching") {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
      }
      return serve(a)(req);
    };
    stubFetch({ [A]: slow });
    await Promise.all([syncAllPeers(hub), syncPeerByInstance(hub, "a.example")]);
    expect(maxInFlight).toBe(1);
  });
});

describe("relay queue purge", () => {
  it("keeps store-and-forward queries that are still in flight", async () => {
    const hub = instanceEnv("hub.example", await newFedKey());
    const old = nowS() - 2 * 3600;
    await hub.DB.prepare(
      "INSERT INTO fed_relay_queue (instance, kind, params, status, created_at) VALUES ('s.example','feed','{}','dispatched',?), ('s.example','feed','{}','answered',?)",
    )
      .bind(old, old)
      .run();
    await purgeRelayQueue(hub);
    const rows = (await hub.DB.prepare("SELECT status FROM fed_relay_queue").all<{ status: string }>()).results;
    expect(rows.map((r) => r.status)).toEqual(["dispatched"]);
  });
});
