// SPDX-License-Identifier: AGPL-3.0-or-later
// Federation identity binding, end to end over real instances: an instance id belongs to the peer
// row that first proved it, a pinned key moves only along a verified rotation chain, and every
// carrier verifies frames against the same stored key set.
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers, applyFedFrames, keysForOrigin } from "@aprscaching/gateway/federation_sync";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import {
  newFedKey,
  rotation,
  instanceEnv,
  addCache,
  serve,
  withDescriptor,
  splitServe,
  stubFetch,
  servedFrames,
  peerRow,
  remoteCacheCount,
} from "./helpers/fedpeer.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const A = "https://a.example";
const B = "https://b.example";

async function hubWithPeers(...urls: string[]) {
  const hub = instanceEnv("hub.example", await newFedKey());
  for (const u of urls)
    await hub.DB.prepare("INSERT INTO fed_peers (url, trust, added_via) VALUES (?, 'trusted', 'manual')").bind(u).run();
  return hub;
}

describe("instance ids are bound to one peer", () => {
  it("binds the instance on first sight and refuses a descriptor that renames it", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key);
    await addCache(a);
    const routes = stubFetch({ [A]: serve(a) });
    const hub = await hubWithPeers(A);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect((await peerRow(hub, A))?.instance).toBe("a.example");

    routes[A] = withDescriptor(serve(a), (wk) => ({ ...wk, instance: "other.example" }));
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/instance/);
    expect((await peerRow(hub, A))?.instance).toBe("a.example");
  });

  it("rejects a second peer claiming an existing instance id", async () => {
    const genuine = instanceEnv("x.example", await newFedKey());
    const impostor = instanceEnv("x.example", await newFedKey());
    await addCache(genuine);
    await addCache(impostor, 5000);
    stubFetch({ [A]: serve(genuine), [B]: serve(impostor) });
    const hub = await hubWithPeers(A);
    await syncAllPeers(hub);
    await hub.DB.prepare("INSERT INTO fed_peers (url, trust, added_via) VALUES (?, 'trusted', 'manual')").bind(B).run();

    const r = await syncAllPeers(hub);
    expect(r.errors.some((e) => e.slice(0, e.indexOf(": ")) === B)).toBe(true);
    expect((await peerRow(hub, B))?.instance ?? null).toBeNull();
    const titles = await hub.DB.prepare("SELECT updated_at FROM remote_caches WHERE origin = 'x.example'").all<{
      updated_at: number;
    }>();
    expect(titles.results.map((t) => t.updated_at)).toEqual([1000]); // only the genuine peer's record
  });

  it("refuses a prefix instance such as b.example:cache", async () => {
    const b = instanceEnv("b.example", await newFedKey());
    await addCache(b);
    stubFetch({ [A]: withDescriptor(serve(b), (wk) => ({ ...wk, instance: "b.example:cache" })) });
    const hub = await hubWithPeers(A);
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/instance/);
    expect((await peerRow(hub, A))?.instance ?? null).toBeNull();
    expect(await remoteCacheCount(hub, "b.example:cache")).toBe(0);
  });

  it("a tombstone recorded from one origin never suppresses another origin's record", async () => {
    const key = await newFedKey();
    const b = instanceEnv("b.example", key);
    const id = await addCache(b);
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, 'b.example', ?, 'trusted', 'manual')",
    )
      .bind(B, key.pub)
      .run();
    await hub.DB.prepare(
      "INSERT INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at) VALUES (?, 'a.example', 'cache', 1, 1)",
    )
      .bind(`b.example:cache:${id}`)
      .run();
    const r = await applyFedFrames(hub, await servedFrames(b));
    expect(r.applied).toBe(1);
    expect(await remoteCacheCount(hub, "b.example")).toBe(1);
  });

  for (const order of ["blocked row first", "live row first"] as const) {
    it(`a blocked row blocks the instance under every address, a live row beside it too (${order})`, async () => {
      const good = await newFedKey();
      const evil = await newFedKey();
      const live = instanceEnv("b.example", good);
      const blockedSigner = instanceEnv("b.example", evil);
      await addCache(live);
      await addCache(blockedSigner);
      const hub = instanceEnv("hub.example", await newFedKey());
      const rows = [
        ["https://old.b.example", evil.pub, "blocked"],
        [B, good.pub, "trusted"],
      ];
      if (order === "live row first") rows.reverse();
      for (const [url, pub, trust] of rows)
        await hub.DB.prepare(
          "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, 'b.example', ?, ?, 'manual')",
        )
          .bind(url, pub, trust)
          .run();
      expect(await applyFedFrames(hub, await servedFrames(live))).toMatchObject({ applied: 0, quarantined: 1 });
      expect((await applyFedFrames(hub, await servedFrames(blockedSigner))).applied).toBe(0);
      expect(await keysForOrigin(hub, "b.example")).toBe("blocked");
    });
  }
});

describe("a pinned key moves only along a verified rotation", () => {
  async function pinnedHub() {
    const k1 = await newFedKey();
    const a = instanceEnv("a.example", k1);
    await addCache(a);
    const routes = stubFetch({ [A]: serve(a) });
    const hub = await hubWithPeers(A);
    await syncAllPeers(hub);
    return { k1, a, routes, hub };
  }

  it("refuses frames signed by an extra, unproven key listed in publicKeys", async () => {
    const { k1, a, routes, hub } = await pinnedHub();
    const evil = await newFedKey();
    const evilSigner = instanceEnv("a.example", evil, {}, a.DB);
    await addCache(a, 9000);
    routes[A] = splitServe(
      withDescriptor(serve(a), (wk) => ({ ...wk, publicKeys: [{ x: k1.pub }, { x: evil.pub }] })),
      serve(evilSigner),
    );
    await syncAllPeers(hub);
    expect(await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches WHERE updated_at = 9000").first()).toEqual({
      n: 0,
    });
    expect((await peerRow(hub, A))?.public_key).toBe(k1.pub);
    // the same key set governs the store-and-forward carriers
    expect((await applyFedFrames(hub, await servedFrames(evilSigner))).applied).toBe(0);
  });

  it("never re-pins to a key that no rotation from the pin reaches", async () => {
    const { k1, a, routes, hub } = await pinnedHub();
    const evil = await newFedKey();
    const hijacked = instanceEnv("a.example", evil, {}, a.DB);
    routes[A] = withDescriptor(serve(hijacked), (wk) => ({ ...wk, publicKeys: [{ x: k1.pub }, { x: evil.pub }] }));
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/rotation/);
    expect((await peerRow(hub, A))?.public_key).toBe(k1.pub);
    expect((await applyFedFrames(hub, await servedFrames(hijacked))).applied).toBe(0);
  });

  it("follows a verified rotation to the new key", async () => {
    const { k1, a, routes, hub } = await pinnedHub();
    const k2 = await newFedKey();
    const at = Math.floor(Date.now() / 1000);
    const rotated = instanceEnv(
      "a.example",
      k2,
      {
        FED_KEY_HISTORY: JSON.stringify([{ x: k1.pub, until: at + 86400 }]),
        FED_ROTATIONS: JSON.stringify([await rotation(k1, k2, at)]),
      },
      a.DB,
    );
    routes[A] = serve(rotated);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect((await peerRow(hub, A))?.public_key).toBe(k2.pub);
  });
});

describe("rotated-away keys are revoked after their grace, on every carrier", () => {
  const DAY = 86400;

  async function rotatedPeer(history: (k1: string, at: number) => unknown[]) {
    const k1 = await newFedKey();
    const k2 = await newFedKey();
    const at = Math.floor(Date.now() / 1000);
    const a = instanceEnv("a.example", k2, {
      FED_KEY_HISTORY: JSON.stringify(history(k1.pub, at)),
      FED_ROTATIONS: JSON.stringify([await rotation(k1, k2, at)]),
    });
    await addCache(a);
    const oldSigner = instanceEnv("a.example", k1, {}, a.DB);
    // the hub first knows the peer under k1, then sees it rotate: only a key it trusted before can
    // become a predecessor
    const routes = stubFetch({ [A]: serve(oldSigner) });
    const hub = await hubWithPeers(A);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    routes[A] = serve(a);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    return { k1, at, a, oldSigner, routes, hub };
  }

  it("a history key without an until (the old rotation tool's output) expires after the default grace", async () => {
    const { at, a, oldSigner, routes, hub } = await rotatedPeer((k1, at) => [{ x: k1, since: at }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((at + DAY) * 1000);
    await addCache(a, at + 100); // a record the hub has not seen yet
    expect((await applyFedFrames(hub, await servedFrames(oldSigner))).applied).toBe(1); // within grace

    vi.setSystemTime((at + 8 * DAY) * 1000);
    await addCache(a, at + 200);
    expect((await applyFedFrames(hub, await servedFrames(oldSigner))).applied).toBe(0); // BBS / beacon / circuit
    await addCache(a, 7777);
    routes[A] = splitServe(serve(a), serve(oldSigner));
    await syncAllPeers(hub); // HTTP sync
    expect(await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches WHERE updated_at = 7777").first()).toEqual({
      n: 0,
    });
  });

  it("a later descriptor cannot revive a key once its grace has passed", async () => {
    const { k1, at, a, oldSigner, routes, hub } = await rotatedPeer((k1, at) => [{ x: k1, until: at + 2 * DAY }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((at + 3 * DAY) * 1000);
    routes[A] = withDescriptor(serve(a), (wk) => ({
      ...wk,
      publicKeys: [{ x: wk.publicKey }, { x: k1.pub, until: at + 365 * DAY }],
    }));
    await syncAllPeers(hub);
    expect((await applyFedFrames(hub, await servedFrames(oldSigner))).applied).toBe(0);
    await addCache(a, 8888);
    routes[A] = splitServe(routes[A]!, serve(oldSigner));
    await syncAllPeers(hub);
    expect(await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches WHERE updated_at = 8888").first()).toEqual({
      n: 0,
    });
  });
});

describe("frame acceptance", () => {
  it("refuses a frame whose signer is empty", async () => {
    const key = await newFedKey();
    const b = instanceEnv("b.example", key);
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, 'b.example', ?, 'trusted', 'manual')",
    )
      .bind(B, key.pub)
      .run();
    const frame = await signFedRecord(b, {
      kind: "cache",
      gid: "b.example:cache:1",
      origin: "b.example",
      v: 1000,
      at: 1000,
      signer: "",
      body: { code: "AC-X", title: "unsigned", updatedAt: 1000 },
    });
    expect((await applyFedFrames(hub, [frame!])).applied).toBe(0);
  });
});
