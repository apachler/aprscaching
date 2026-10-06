// SPDX-License-Identifier: AGPL-3.0-or-later
// The region filter on the caches sync feed and the narrowed pull: a publisher serves only the caches
// inside a box when asked, and says so in its descriptor; a subscriber with FED_SYNC_REGION asks for
// its box where that is served, reads the whole feed elsewhere, and reads the caches again whenever its
// region changes; deletes are never filtered. A narrowed pull reads only some feeds, some pages.
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { decodeFedSyncPage } from "@aprscaching/gateway/fedsync";
import { parseBbox, bboxKey } from "@aprscaching/gateway/fedregion";
import { emitTombstones } from "@aprscaching/gateway/tombstones";
import { gid, newFedKey, instanceEnv, serve, stubFetch, withDescriptor, remoteCacheCount } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const A = "https://a.example";
const GRAZ = "46.9,15.2,47.2,15.7";

let seq = 0;
async function cacheAt(env: Env, lat: number, lon: number, updatedAt = 1000): Promise<number> {
  const n = ++seq;
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at)
     VALUES (?, 'OE8APR', ?, 'traditional', ?, ?, ?, ?)`,
  )
    .bind(`AC-R${n}`, `Region cache ${n}`, lat, lon, updatedAt, updatedAt)
    .run();
  return Number(r.meta.last_row_id);
}

async function served(env: Env, query: string): Promise<Response> {
  return serve(env)(new Request(`${A}/federation/sync/${query}`));
}
async function frameCount(res: Response): Promise<number> {
  return decodeFedSyncPage(new Uint8Array(await res.arrayBuffer())).frames.length;
}

/** How far the hub holds a.example's records of one kind, and the region it read them under. */
const markOf = (hub: Env, kind: string) =>
  hub.DB.prepare("SELECT seq, region FROM fed_origin_marks WHERE origin = 'a.example' AND kind = ?")
    .bind(kind)
    .first<{ seq: number; region: string }>();

async function pair(hubExtra: Record<string, unknown> = {}) {
  const key = await newFedKey();
  const a = instanceEnv("a.example", key);
  const hub = instanceEnv("hub.example", await newFedKey(), hubExtra);
  await hub.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, 'a.example', ?, 'trusted', 'manual')",
  )
    .bind(A, key.pub)
    .run();
  return { a, hub };
}

describe("parseBbox", () => {
  it("takes S,W,N,E in decimal degrees", () => {
    expect(parseBbox("46.9,15.2,47.2,15.7")).toEqual({ south: 46.9, west: 15.2, north: 47.2, east: 15.7 });
    expect(bboxKey(parseBbox(" 46.90 , 15.2,47.2,15.7")!)).toBe("46.9,15.2,47.2,15.7");
  });
  it("allows a box across the antimeridian (west > east)", () => {
    expect(parseBbox("-20,170,-10,-170")).toEqual({ south: -20, west: 170, north: -10, east: -170 });
  });
  it("refuses anything else", () => {
    for (const bad of [
      "",
      "1,2,3",
      "1,2,3,4,5",
      "a,b,c,d",
      "47.2,15.2,46.9,15.7", // south > north
      "-91,0,0,1",
      "0,-181,1,0",
      "1e1,2,3,4",
      "0,0,1,1;DROP",
    ])
      expect(parseBbox(bad), bad).toBeNull();
  });
});

describe("the publisher", () => {
  it("serves only the caches inside the box, and advertises the filter", async () => {
    const a = instanceEnv("a.example", await newFedKey());
    await cacheAt(a, 47.07, 15.42); // Graz
    await cacheAt(a, 48.21, 16.37); // Vienna
    await cacheAt(a, 35.68, 139.69); // Tokyo
    expect(await frameCount(await served(a, "cache?since=0"))).toBe(3);
    expect(await frameCount(await served(a, `cache?since=0&bbox=${GRAZ}`))).toBe(1);
    const wk = (await (await serve(a)(new Request(`${A}/.well-known/aprscaching`))).json()) as {
      capabilities: string[];
    };
    expect(wk.capabilities).toContain("sync-cache-bbox");
  });

  it("filters across the antimeridian", async () => {
    const a = instanceEnv("a.example", await newFedKey());
    await cacheAt(a, -17, 179.5);
    await cacheAt(a, -17, -179.5);
    await cacheAt(a, -17, 0);
    expect(await frameCount(await served(a, "cache?since=0&bbox=-20,170,-10,-170"))).toBe(2);
  });

  it("refuses a malformed box on the caches feed and ignores a box on every other feed", async () => {
    const a = instanceEnv("a.example", await newFedKey());
    const id = await cacheAt(a, 48.21, 16.37);
    expect((await served(a, "cache?since=0&bbox=1,2,3")).status).toBe(400);
    await emitTombstones(a, "a.example", [{ kind: "cache", targetId: await gid(a, "cache", id) }]);
    expect(await frameCount(await served(a, `tombstone?since=0&bbox=${GRAZ}`))).toBe(1);
  });

  it("does not advertise the filter without a signing key", async () => {
    const a = instanceEnv("a.example", null);
    const wk = (await (await serve(a)(new Request(`${A}/.well-known/aprscaching`))).json()) as {
      capabilities: string[];
    };
    expect(wk.capabilities).not.toContain("sync-cache-bbox");
  });
});

describe("the subscriber", () => {
  it("pulls only its region from a publisher that filters, and records the region", async () => {
    const { a, hub } = await pair({ FED_SYNC_REGION: GRAZ });
    await cacheAt(a, 47.07, 15.42);
    await cacheAt(a, 48.21, 16.37);
    stubFetch({ [A]: serve(a) });
    const r = await syncAllPeers(hub);
    expect(r.errors).toEqual([]);
    expect(await remoteCacheCount(hub, "a.example")).toBe(1);
    expect((await markOf(hub, "cache"))?.region).toBe(GRAZ);
  });

  it("pulls the whole feed from a publisher without the filter", async () => {
    const { a, hub } = await pair({ FED_SYNC_REGION: GRAZ });
    await cacheAt(a, 47.07, 15.42);
    await cacheAt(a, 48.21, 16.37);
    const noFilter = withDescriptor(serve(a), (wk) => ({
      ...wk,
      capabilities: (wk.capabilities as string[]).filter((c) => c !== "sync-cache-bbox"),
    }));
    stubFetch({ [A]: noFilter });
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(2);
    expect((await markOf(hub, "cache"))?.region).toBe("");
  });

  it("reads the feed again from the start when the region changes", async () => {
    const { a, hub } = await pair({ FED_SYNC_REGION: GRAZ });
    await cacheAt(a, 47.07, 15.42, 1000);
    await cacheAt(a, 48.21, 16.37, 1000); // outside, and below the mark after the first pull
    await cacheAt(a, 47.1, 15.45, 2000);
    stubFetch({ [A]: serve(a) });
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(2);
    const top = (await a.DB.prepare("SELECT n FROM fed_seq WHERE kind = 'cache'").first<{ n: number }>())!.n;
    expect(await markOf(hub, "cache")).toEqual({ seq: top, region: GRAZ });

    (hub as { FED_SYNC_REGION?: string }).FED_SYNC_REGION = undefined; // back to the whole feed
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(3);
    expect(await markOf(hub, "cache")).toEqual({ seq: top, region: "" });
  });

  it("still receives the delete of a cache outside its region", async () => {
    const { a, hub } = await pair();
    const vienna = await cacheAt(a, 48.21, 16.37);
    stubFetch({ [A]: serve(a) });
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(1);

    (hub as { FED_SYNC_REGION?: string }).FED_SYNC_REGION = GRAZ;
    const target = await gid(a, "cache", vienna);
    await a.DB.prepare("DELETE FROM caches WHERE id = ?").bind(vienna).run();
    await emitTombstones(a, "a.example", [{ kind: "cache", targetId: target }]);
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(0);
  });

  it("ignores a malformed FED_SYNC_REGION and pulls every cache", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { a, hub } = await pair({ FED_SYNC_REGION: "somewhere" });
    await cacheAt(a, 47.07, 15.42);
    await cacheAt(a, 48.21, 16.37);
    stubFetch({ [A]: serve(a) });
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(2);
    expect(warn).toHaveBeenCalled();
  });
});

describe("a narrowed pull", () => {
  it("reads only the feeds asked for, plus deletes, and reports the bytes", async () => {
    const { a, hub } = await pair();
    const id = await cacheAt(a, 47.07, 15.42);
    await a.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type) VALUES (?, 'OE8LOG', 1000, 'found')",
    )
      .bind(id)
      .run();
    const gone = await cacheAt(a, 47.08, 15.43);
    const target = await gid(a, "cache", gone);
    await a.DB.prepare("DELETE FROM caches WHERE id = ?").bind(gone).run();
    await emitTombstones(a, "a.example", [{ kind: "cache", targetId: target }]);
    stubFetch({ [A]: serve(a) });
    const r = await syncAllPeers(hub, { types: ["cache"] });
    expect(r.errors).toEqual([]);
    expect(r.caches).toBe(1);
    expect(r.tombstones).toBe(1);
    expect(r.finds).toBe(0);
    expect(r.bytes).toBeGreaterThan(0);
    expect(await markOf(hub, "find")).toBeNull();
    const tomb = (await a.DB.prepare("SELECT fed_seq FROM tombstones").first<{ fed_seq: number }>())!.fed_seq;
    expect(await markOf(hub, "tombstone")).toEqual({ seq: tomb, region: "" });
  });

  it("stops after the page cap, and the next pass carries on", async () => {
    const { a, hub } = await pair();
    for (let i = 0; i < 600; i++) await cacheAt(a, 47.07, 15.42, 1000 + i);
    stubFetch({ [A]: serve(a) });
    await syncAllPeers(hub, { types: ["cache"], maxPages: 1 });
    expect(await remoteCacheCount(hub, "a.example")).toBe(500);
    await syncAllPeers(hub);
    expect(await remoteCacheCount(hub, "a.example")).toBe(600);
  });
});

describe("POST /federation/sync", () => {
  const post = (env: Env, body: unknown, secret = "test-operator-secret") =>
    serve(env)(
      new Request("https://hub.example/federation/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-secret": secret },
        body: JSON.stringify(body),
      }),
    );

  it("takes types and maxPages, and refuses anything else", async () => {
    const { a, hub } = await pair();
    await cacheAt(a, 47.07, 15.42);
    stubFetch({ [A]: serve(a) });
    const ok = await post(hub, { types: ["cache", "key"], maxPages: 2 });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { caches: number; bytes: number };
    expect(body.caches).toBe(1);
    expect(body.bytes).toBeGreaterThan(0);
    expect((await post(hub, { types: ["everything"] })).status).toBe(400);
    expect((await post(hub, { types: "cache" })).status).toBe(400);
    expect((await post(hub, { maxPages: 0 })).status).toBe(400);
    expect((await post(hub, { maxPages: 51 })).status).toBe(400);
  });

  it("is operator-only", async () => {
    const { hub } = await pair();
    expect((await post(hub, {}, "wrong")).status).toBe(401);
  });
});
