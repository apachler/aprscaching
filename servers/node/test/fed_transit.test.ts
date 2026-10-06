// SPDX-License-Identifier: AGPL-3.0-or-later
// A hub passes on what it mirrored: A ⇄ hub ⇄ B, where B never peers with A. A's records reach B as A signed
// them, through the hub's summary and origin pages, verified under A's key and shown with B's own trust in A;
// blocks, deletes and restores follow the same way; records never circle between hubs that follow each other;
// a local-only cache never leaves A.
import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers, applyFedFrames } from "@aprscaching/gateway/federation_sync";
import { queryPeerCorroboration } from "@aprscaching/gateway/corroborate";
import { decodeFedSyncPage } from "@aprscaching/gateway/fedsync";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import { bodyToWire } from "@aprscaching/gateway/fedsync";
import { call } from "./helpers/authflow.js";
import { addCache, instanceEnv, newFedKey, serve, stubFetch, type FedKey } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const OP = { "x-operator-secret": "test-operator-secret" };
const now = () => Math.floor(Date.now() / 1000);
const fp = (k: FedKey) =>
  createHash("sha256")
    .update(Buffer.from(k.pub, "base64url"))
    .digest("hex")
    .slice(0, 16)
    .replace(/(.{4})(?=.)/g, "$1 ");

async function follow(env: Env, url: string, instance: string | null, key: FedKey, trust = "trusted") {
  await env.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, ?, ?, ?, 'manual')",
  )
    .bind(url, instance, key.pub, trust)
    .run();
}

async function addFind(env: Env, cacheId: number): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, comment) VALUES (?, 'DL1FND', ?, 'found', 0, 'tftc')",
  )
    .bind(cacheId, now() - 30)
    .run();
  return Number(r.meta.last_row_id);
}

/** A spoke `a`, a hub following it, and `b` following only the hub. */
async function world(
  opts: {
    hubTrustsA?: string;
    aEnv?: Record<string, unknown>;
    hubEnv?: Record<string, unknown>;
    bEnv?: Record<string, unknown>;
  } = {},
) {
  const ka = await newFedKey(),
    kh = await newFedKey(),
    kb = await newFedKey();
  const a = instanceEnv("a.example", ka, opts.aEnv);
  const hub = instanceEnv("hub.example", kh, opts.hubEnv);
  const b = instanceEnv("b.example", kb, opts.bEnv);
  await follow(hub, "https://a.example", "a.example", ka, opts.hubTrustsA ?? "trusted");
  await follow(b, "https://hub.example", "hub.example", kh);
  const cacheId = await addCache(a, now() - 60);
  const findId = await addFind(a, cacheId);
  stubFetch({ "https://a.example": serve(a), "https://hub.example": serve(hub), "https://b.example": serve(b) });
  return { a, hub, b, ka, kh, kb, cacheId, findId };
}

const rows = async (env: Env, sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
  ).results;
const one = async (env: Env, sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<Record<string, unknown>>()) ?? null;

async function mapCaches(env: Env, includeUnvetted = false) {
  const r = await call(env, "GET", `/api/caches${includeUnvetted ? "?includeUnvetted=1" : ""}`);
  return (r.data.caches as Array<{ origin?: string; originTrust?: string }>).filter((c) => c.origin === "a.example");
}

/** One page of an origin's records of `kind` as `env` serves them, or null when it serves none. */
async function originPage(env: Env, kind: string, query = "", origin = "a.example") {
  const res = await serve(env)(
    new Request(`https://hub.example/federation/sync/origin?origin=${origin}&kind=${kind}&since=0${query}`),
  );
  return res.status === 200 ? decodeFedSyncPage(new Uint8Array(await res.arrayBuffer())) : null;
}

describe("a hub passes its spokes' records on", () => {
  it("A's cache and find reach B through the hub, signed by A, and B treats A as unvetted", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);

    const cache = await one(
      w.b,
      "SELECT origin FROM remote_caches WHERE global_id = ?",
      `a.example:cache:${w.cacheId}`,
    );
    expect(cache).toEqual({ origin: "a.example" });
    expect(await one(w.b, "SELECT origin FROM remote_finds WHERE global_id = ?", `a.example:find:${w.findId}`)).toEqual(
      {
        origin: "a.example",
      },
    );
    // the frames are the ones A signed, byte for byte, under A's key
    const held = await rows(w.b, "SELECT gid, frame, signer_key, via, hops FROM fed_transit ORDER BY gid");
    expect(held.map((r) => [r.gid, r.signer_key, r.via, r.hops])).toEqual([
      [`a.example:cache:${w.cacheId}`, w.ka.pub, "hub.example", 2],
      [`a.example:find:${w.findId}`, w.ka.pub, "hub.example", 2],
    ]);
    const atHub = await one(w.hub, "SELECT frame FROM fed_transit WHERE gid = ?", `a.example:cache:${w.cacheId}`);
    expect(Buffer.from(held[0]!.frame as Uint8Array).equals(Buffer.from(atHub!.frame as Uint8Array))).toBe(true);

    // B learned A's key from the hub: an unvetted origin, never pulled, its records hidden by default
    expect(
      await one(w.b, "SELECT url, trust, enabled, public_key FROM fed_peers WHERE instance = 'a.example'"),
    ).toEqual({
      url: "transit:a.example",
      trust: "unvetted",
      enabled: 0,
      public_key: w.ka.pub,
    });
    expect(await mapCaches(w.b)).toEqual([]);
    expect((await mapCaches(w.b, true)).map((c) => c.originTrust)).toEqual(["unvetted"]);
    // the key came from the hub's summary of the origins it passes on, beside how far it holds each
    const summary = await call(w.hub, "GET", "/federation/sync/summary?for=b.example");
    expect(summary.data.origins).toEqual([
      {
        origin: "a.example",
        held: { cache: expect.any(Number), find: w.findId },
        publicKey: w.ka.pub,
        publicKeys: [{ x: w.ka.pub }],
        rotations: [],
      },
      { origin: "hub.example", held: { tombstone: 0, "account-move": 0, cache: 0, find: 0 } },
    ]);
    // and B holds A as far as the hub does, which it trusts
    expect(await rows(w.b, "SELECT kind, seq FROM fed_origin_marks WHERE origin = 'a.example' ORDER BY kind")).toEqual(
      await rows(w.hub, "SELECT kind, seq FROM fed_origin_marks WHERE origin = 'a.example' ORDER BY kind"),
    );
  });

  it("B's sysop trusts A by its fingerprint, or blocks it, like any peer", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    const trust = (t: string, fingerprint?: string) =>
      call(w.b, "POST", "/federation/peers/trust", { url: "transit:a.example", trust: t, fingerprint }, OP);

    expect((await trust("trusted", fp(w.kh))).status).toBe(409); // the hub's key is not A's
    expect((await trust("trusted", fp(w.ka))).status).toBe(200);
    expect((await mapCaches(w.b)).map((c) => c.originTrust)).toEqual(["trusted"]);

    expect((await trust("blocked")).status).toBe(200);
    expect(await mapCaches(w.b, true)).toEqual([]);
    // a blocked origin's frames stay out, whoever passes them on
    await w.a.DB.prepare("UPDATE caches SET title = 'edited', updated_at = ? WHERE id = ?")
      .bind(now(), w.cacheId)
      .run();
    await syncAllPeers(w.hub);
    const page = await originPage(w.hub, "cache", "&for=b.example");
    expect((await applyFedFrames(w.b, page!.frames)).applied).toBe(0);
    await syncAllPeers(w.b);
    expect(await one(w.b, "SELECT title FROM remote_caches WHERE origin = 'a.example'")).not.toEqual({
      title: "edited",
    });
  });

  it("A's deletion reaches B, and so does a sysop's restore", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(
      (
        await call(
          w.a,
          "POST",
          "/api/admin/moderation/remove",
          { kind: "cache", id: w.cacheId, reason: "takedown" },
          OP,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(w.a, "POST", "/api/admin/moderation/remove", { kind: "log", id: w.findId, reason: "takedown" }, OP))
        .status,
    ).toBe(200);
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(await rows(w.b, "SELECT global_id FROM remote_caches")).toEqual([]);
    expect(await rows(w.b, "SELECT global_id FROM remote_finds")).toEqual([]);
    // the hub no longer passes on what was deleted, only the deletions
    expect((await rows(w.hub, "SELECT kind FROM fed_transit ORDER BY kind")).map((r) => r.kind)).toEqual([
      "tombstone",
      "tombstone",
    ]);

    expect(
      (
        await call(
          w.a,
          "POST",
          "/api/admin/moderation/restore",
          { kind: "cache", id: w.cacheId, reason: "appeal upheld" },
          OP,
        )
      ).status,
    ).toBe(200);
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(
      await one(w.b, "SELECT status FROM remote_caches WHERE global_id = ?", `a.example:cache:${w.cacheId}`),
    ).toEqual({
      status: "disabled",
    });
  });

  it("an erasure reaches an instance that pulls the hub only after it", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    await w.a.DB.prepare(
      "INSERT INTO tombstones (id, kind, target_id, origin, ts) VALUES ('t1', 'cache', ?, 'a.example', ?)",
    )
      .bind(`a.example:cache:${w.cacheId}`, now())
      .run();
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(await rows(w.b, "SELECT global_id FROM remote_caches")).toEqual([]);
    expect(
      await one(w.b, "SELECT origin FROM remote_tombstones WHERE target_id = ?", `a.example:cache:${w.cacheId}`),
    ).toEqual({
      origin: "a.example",
    });
  });

  it("passes on only what FED_RESERVE allows, and a newly trusted origin's records go out then", async () => {
    const off = await world({ hubEnv: { FED_RESERVE: "off" } });
    await syncAllPeers(off.hub);
    expect(await originPage(off.hub, "cache")).toBeNull();
    // the summary names the hub alone
    const summary = await call(off.hub, "GET", "/federation/sync/summary");
    expect(summary.data.origins.map((o: { origin: string }) => o.origin)).toEqual(["hub.example"]);

    vi.unstubAllGlobals();
    const w = await world({ hubTrustsA: "unvetted" });
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(await rows(w.b, "SELECT global_id FROM remote_caches")).toEqual([]); // the hub does not trust A
    expect(
      (
        await call(
          w.hub,
          "POST",
          "/federation/peers/trust",
          { url: "https://a.example", trust: "trusted", fingerprint: fp(w.ka) },
          OP,
        )
      ).status,
    ).toBe(200);
    await syncAllPeers(w.b);
    expect((await rows(w.b, "SELECT global_id FROM remote_caches")).length).toBe(1);
  });

  it("corroboration's auto-promotion sends the newly trusted origin's older records on", async () => {
    const LOGGER = "OE8LOG";
    const heard = async (env: Env) =>
      env.DB.prepare(
        "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport) VALUES (?, ?, 47.07, 15.44, 'rf', 'OE8XXX', 'WIDE1-1', 'aprs', 'tnc')",
      )
        .bind(LOGGER, now() - 600)
        .run();
    const w = await world({
      hubTrustsA: "unvetted",
      hubEnv: { FED_CORROBORATION_QUORUM: "1", FED_AUTO_PROMOTE: "1" },
      aEnv: { FIRST_PARTY_SITES: "OE8XXX" },
    });
    // a peer the hub trusts, whose answer confirms the corroboration A also answers
    const kp = await newFedKey();
    const p = instanceEnv("p.example", kp, { FIRST_PARTY_SITES: "OE8XXX" });
    await follow(w.hub, "https://p.example", "p.example", kp);
    await heard(w.a);
    await heard(p);
    stubFetch({
      "https://a.example": serve(w.a),
      "https://hub.example": serve(w.hub),
      "https://b.example": serve(w.b),
      "https://p.example": serve(p),
    });
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(await rows(w.b, "SELECT global_id FROM remote_caches")).toEqual([]);

    const q = { callsign: LOGGER, lat: 47.07, lon: 15.44, radiusM: 150, since: now() - 1800, until: now() };
    expect(await queryPeerCorroboration(w.hub, q)).not.toBeNull();
    expect(await one(w.hub, "SELECT trust FROM fed_peers WHERE url = 'https://a.example'")).toEqual({
      trust: "trusted",
    });
    await syncAllPeers(w.b);
    expect((await rows(w.b, "SELECT global_id FROM remote_caches WHERE origin = 'a.example'")).length).toBe(1);
    expect((await rows(w.b, "SELECT global_id FROM remote_finds WHERE origin = 'a.example'")).length).toBe(1);
  });

  it("a wider FED_RESERVE lets its records out at the next pull, off → trusted and trusted → all", async () => {
    const setReserve = async (env: Env, value: string) =>
      expect((await call(env, "PUT", "/api/admin/settings/FED_RESERVE", { value }, OP)).status).toBe(200);

    // off → trusted: the trusted origin's records go out
    const w = await world();
    await setReserve(w.hub, "off");
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(await rows(w.b, "SELECT global_id FROM remote_caches")).toEqual([]);
    await setReserve(w.hub, "trusted");
    await syncAllPeers(w.b);
    expect((await rows(w.b, "SELECT global_id FROM remote_caches")).length).toBe(1);

    // trusted → all: an origin the hub has not vetted goes out too, also when the environment sets it
    vi.unstubAllGlobals();
    const u = await world({ hubTrustsA: "unvetted" });
    await syncAllPeers(u.hub);
    await syncAllPeers(u.b);
    expect(await rows(u.b, "SELECT global_id FROM remote_caches")).toEqual([]);
    const restarted = instanceEnv("hub.example", u.kh, { FED_RESERVE: "all" }, u.hub.DB);
    stubFetch({
      "https://a.example": serve(u.a),
      "https://hub.example": serve(restarted),
      "https://b.example": serve(u.b),
    });
    await syncAllPeers(u.b);
    expect((await rows(u.b, "SELECT global_id FROM remote_caches")).length).toBe(1);
  });

  it("never sends a record back to its origin or the instance it came from", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    expect(await originPage(w.hub, "cache", "&for=a.example")).toBeNull();
    expect((await originPage(w.hub, "cache"))!.frames).toHaveLength(1);
    expect((await originPage(w.hub, "find"))!.frames).toHaveLength(1);
    // A follows its hub: nothing of its own comes back
    await follow(w.a, "https://hub.example", "hub.example", w.kh);
    await syncAllPeers(w.a);
    expect(await rows(w.a, "SELECT gid FROM fed_transit")).toEqual([]);
  });

  it("two hubs following each other pass a record on once, and it stops there", async () => {
    const w = await world();
    const k2 = await newFedKey();
    const hub2 = instanceEnv("hub2.example", k2);
    await follow(hub2, "https://hub.example", "hub.example", w.kh);
    await follow(w.hub, "https://hub2.example", "hub2.example", k2);
    // hub2 trusts A too, by its fingerprint, so it passes A's records on as well
    stubFetch({
      "https://a.example": serve(w.a),
      "https://hub.example": serve(w.hub),
      "https://hub2.example": serve(hub2),
    });
    await syncAllPeers(w.hub);
    await syncAllPeers(hub2);
    expect(
      (
        await call(
          hub2,
          "POST",
          "/federation/peers/trust",
          { url: "transit:a.example", trust: "trusted", fingerprint: fp(w.ka) },
          OP,
        )
      ).status,
    ).toBe(200);
    const before = await rows(w.hub, "SELECT gid, v, hops, via FROM fed_transit ORDER BY gid");
    for (let i = 0; i < 3; i++) {
      await syncAllPeers(w.hub);
      await syncAllPeers(hub2);
    }
    expect(await rows(w.hub, "SELECT gid, v, hops, via FROM fed_transit ORDER BY gid")).toEqual(before);
    expect((await rows(hub2, "SELECT hops, via FROM fed_transit")).map((r) => [r.hops, r.via])).toEqual([
      [2, "hub.example"],
      [2, "hub.example"],
    ]);
    // hub2 offers the hub nothing it got from the hub
    expect((await originPage(hub2, "cache", "&for=hub.example"))!.frames).toHaveLength(0);
  });

  it("stops passing a record on after the hop limit", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    await w.hub.DB.prepare("UPDATE fed_transit SET hops = 4").run();
    const page = (await originPage(w.hub, "cache"))!;
    expect(page.frames).toHaveLength(0);
    // the hub holds A whole only up to before it, so a puller fills the gap from another neighbour
    expect(page.held).toBe(0);
  });

  it("a local-only or imported cache never leaves its origin, whoever signs it on", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    const at = now();
    const forged = async (id: number, body: Record<string, unknown>) =>
      (await signFedRecord(w.a, {
        kind: "cache",
        gid: `a.example:cache:${id}`,
        origin: "a.example",
        v: at,
        at,
        signer: "a.example",
        body: bodyToWire({ code: `AC-X${id}`, title: "secret", lat: 47, lon: 15, updatedAt: at, ...body }),
      }))!;
    const r = await applyFedFrames(w.hub, [
      await forged(901, { fedScope: "local-only", source: "native" }),
      await forged(902, { fedScope: "public", source: "gcau" }),
    ]);
    expect(r).toMatchObject({ applied: 0, rejected: 2 });
    // and a kept frame that somehow holds one is never served
    await w.hub.DB.prepare("UPDATE fed_transit SET scope = 'local-only' WHERE kind = 'cache'").run();
    expect((await originPage(w.hub, "cache"))!.frames).toHaveLength(0);
    expect((await originPage(w.hub, "find"))!.frames).toHaveLength(1);
  });

  it("the region narrows passed-on caches too, never deletes", async () => {
    const w = await world({ bEnv: { FED_SYNC_REGION: "-10,-10,10,10" } });
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    expect(await rows(w.b, "SELECT global_id FROM remote_caches")).toEqual([]);
    expect((await rows(w.b, "SELECT global_id FROM remote_finds")).length).toBe(1);
  });

  it("B's own pull of A replaces the hub's key, and drops what only a forged key vouched for", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    // a hub that lied about A's key: B pinned it, and holds records under it
    const fake = await newFedKey();
    await w.b.DB.prepare("UPDATE fed_peers SET public_key = ?, accept_keys = NULL WHERE url = 'transit:a.example'")
      .bind(fake.pub)
      .run();
    await w.b.DB.prepare("UPDATE fed_transit SET signer_key = ? WHERE gid LIKE 'a.example:find:%'")
      .bind(fake.pub)
      .run();
    // as a FED_PEERS entry: the instance id binds at the first pull
    await follow(w.b, "https://a.example", null, w.ka, "unvetted");
    await syncAllPeers(w.b);
    expect(await one(w.b, "SELECT COUNT(*) AS n FROM fed_peers WHERE instance = 'a.example'")).toEqual({ n: 1 });
    expect((await rows(w.b, "SELECT global_id FROM remote_caches")).length).toBe(1); // A's own key vouches for it
    // the find came back from A itself; what only the fake key vouched for is gone
    expect(await rows(w.b, "SELECT gid FROM fed_transit WHERE signer_key = ?", fake.pub)).toEqual([]);
    expect((await rows(w.b, "SELECT global_id FROM remote_finds")).length).toBe(1);
  });

  it("removing an origin learned through a hub drops what its key vouched for", async () => {
    const w = await world();
    await syncAllPeers(w.hub);
    await syncAllPeers(w.b);
    const r = await call(
      w.b,
      "DELETE",
      `/federation/peers?url=${encodeURIComponent("transit:a.example")}`,
      undefined,
      OP,
    );
    expect(r.status).toBe(200);
    expect(await rows(w.b, "SELECT global_id FROM remote_caches")).toEqual([]);
    expect(await rows(w.b, "SELECT origin FROM fed_origin_marks WHERE origin = 'a.example'")).toEqual([]);
  });
});
