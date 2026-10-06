// SPDX-License-Identifier: AGPL-3.0-or-later
// The federation mesh: every instance tracks what it holds per origin, so any neighbour fills a gap, a pull
// switches paths without reading again what it holds, and a record carried by a phone that met one instance
// reaches the next one, signed by its origin. Real gateways throughout, each over its own SQLite database.
import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { pushToHub, syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { decodeFedSyncPage } from "@aprscaching/gateway/fedsync";
import { call } from "./helpers/authflow.js";
import { addCache, instanceEnv, newFedKey, serve, stubFetch, type FedKey, type Serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const OP = { "x-operator-secret": "test-operator-secret" };
const now = () => Math.floor(Date.now() / 1000);
const GRAZ = "46.9,15.2,47.2,15.7";

interface Node {
  name: string;
  url: string;
  env: Env;
  key: FedKey;
}

/** An instance `<name>.example`. */
async function node(name: string, extra: Record<string, unknown> = {}): Promise<Node> {
  const key = await newFedKey();
  return {
    name: `${name}.example`,
    url: `https://${name}.example`,
    env: instanceEnv(`${name}.example`, key, extra),
    key,
  };
}

/** `from` follows `to`, its key pinned, at `trust`. */
async function follow(from: Node, to: Node, trust = "trusted") {
  await from.env.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, ?, ?, ?, 'manual')",
  )
    .bind(to.url, to.name, to.key.pub, trust)
    .run();
}

/** Every request a pull makes, by the instance that served it. */
type Log = Array<{ at: string; path: string; query: URLSearchParams; frames?: number }>;

/** Route fetch to the nodes given (any other is unreachable), logging every origin page each one serves. */
function network(nodes: Node[], log: Log = []): Log {
  const routes: Record<string, Serve> = {};
  for (const n of nodes)
    routes[n.url] = async (req) => {
      const u = new URL(req.url);
      const res = await serve(n.env)(req);
      if (u.pathname === "/federation/sync/origin" && res.status === 200) {
        const frames = decodeFedSyncPage(new Uint8Array(await res.clone().arrayBuffer())).frames.length;
        log.push({ at: n.name, path: u.pathname, query: u.searchParams, frames });
      }
      return res;
    };
  stubFetch(routes);
  return log;
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
const caches = (env: Env, origin = "a.example") =>
  rows(env, "SELECT global_id FROM remote_caches WHERE origin = ? ORDER BY global_id", origin).then((r) =>
    r.map((x) => x.global_id),
  );
const mark = async (env: Env, kind: string, origin = "a.example") =>
  ((await one(env, "SELECT seq FROM fed_origin_marks WHERE origin = ? AND kind = ?", origin, kind))?.seq as number) ??
  0;
const rev = async (env: Env, id: number) =>
  (await one(env, "SELECT fed_rev FROM caches WHERE id = ?", id))!.fed_rev as number;
const fingerprint = (k: FedKey) =>
  createHash("sha256")
    .update(Buffer.from(k.pub, "base64url"))
    .digest("hex")
    .slice(0, 16)
    .replace(/(.{4})(?=.)/g, "$1 ");
/** Pull only from these peers of `n` this pass. */
async function only(n: Node, ...peers: Node[]) {
  await n.env.DB.prepare("UPDATE fed_peers SET enabled = 0 WHERE added_via = 'manual'").run();
  for (const p of peers) await n.env.DB.prepare("UPDATE fed_peers SET enabled = 1 WHERE url = ?").bind(p.url).run();
  return syncAllPeers(n.env);
}
const cachePages = (log: Log, at: string) =>
  log.filter((l) => l.at === at && l.query.get("origin") === "a.example" && l.query.get("kind") === "cache");

describe("per-origin sync", () => {
  it("fills a gap from a different neighbour than the one that brought the earlier records", async () => {
    const [a, h1, h2, b] = await Promise.all([node("a"), node("h1"), node("h2"), node("b")]);
    await follow(h1, a);
    await follow(h2, a);
    await follow(b, h1);
    await follow(b, h2);
    const log = network([a, h1, h2, b]);
    const c1 = await addCache(a.env, now() - 60);
    await syncAllPeers(h1.env);
    await only(b, h1);
    expect(await caches(b.env)).toEqual([`a.example:cache:${c1}`]);
    expect(await mark(b.env, "cache")).toBe(await rev(a.env, c1));

    // a second cache, which only h2 holds
    const c2 = await addCache(a.env, now() - 30);
    await syncAllPeers(h2.env);
    log.length = 0;
    const r = await only(b, h1, h2);
    expect(r.errors).toEqual([]);
    expect(await caches(b.env)).toEqual([`a.example:cache:${c1}`, `a.example:cache:${c2}`]);
    // h1 holds nothing past b's mark and is not asked; h2 is asked for what comes after it, and sends c2 alone
    expect(cachePages(log, "h1.example")).toEqual([]);
    expect(cachePages(log, "h2.example").map((l) => [l.query.get("since"), l.frames])).toEqual([
      [String(await rev(a.env, c1)), 1],
    ]);
    expect(await mark(b.env, "cache")).toBe(await rev(a.env, c2));
  });

  it("switches paths without reading again what it holds, to another hub or to the origin itself", async () => {
    const [a, h1, h2, b] = await Promise.all([node("a"), node("h1"), node("h2"), node("b")]);
    await follow(h1, a);
    await follow(h2, a);
    await follow(b, h1);
    await follow(b, h2);
    const log = network([a, h1, h2, b]);
    for (let i = 0; i < 5; i++) await addCache(a.env, now() - 60);
    await syncAllPeers(h1.env);
    await syncAllPeers(h2.env);
    await only(b, h1);
    expect((await caches(b.env)).length).toBe(5);
    const held = await mark(b.env, "cache");

    // h1 goes away; b pulls h2, which holds the same, and reads none of it again
    log.length = 0;
    await only(b, h2);
    expect(log.filter((l) => l.at === "h2.example" && l.query.get("origin") === "a.example")).toEqual([]);

    // a new cache, and b now follows a itself: the pull starts at what b holds and brings the new one alone
    const c6 = await addCache(a.env, now() - 10);
    // as a FED_PEERS entry: its first pull binds the instance and replaces the key h1 handed on
    await b.env.DB.prepare("INSERT INTO fed_peers (url, trust, added_via) VALUES (?, 'unvetted', 'manual')")
      .bind(a.url)
      .run();
    log.length = 0;
    await only(b, a);
    expect(cachePages(log, "a.example").map((l) => [l.query.get("since"), l.frames])).toEqual([[String(held), 1]]);
    expect(await caches(b.env)).toContain(`a.example:cache:${c6}`);
  });

  it("a deletion is never outrun by a stale copy from another path", async () => {
    const [a, h1, h2, b] = await Promise.all([node("a"), node("h1"), node("h2"), node("b")]);
    await follow(h1, a);
    await follow(h2, a);
    await follow(b, h1);
    await follow(b, h2);
    network([a, h1, h2, b]);
    const id = await addCache(a.env, now() - 60);
    await syncAllPeers(h1.env); // h1 keeps the cache and never hears of its removal
    expect(
      (await call(a.env, "POST", "/api/admin/moderation/remove", { kind: "cache", id, reason: "takedown" }, OP)).status,
    ).toBe(200);
    await syncAllPeers(h2.env); // h2 holds the removal, a tombstone bounded by the version it covers
    expect(await one(h2.env, "SELECT up_to FROM remote_tombstones")).toEqual({ up_to: await rev(a.env, id) });

    // b hears the removal first, then meets h1 with its stale copy
    await b.env.DB.prepare("UPDATE fed_peers SET enabled = 0 WHERE url = ?").bind(h1.url).run();
    await syncAllPeers(b.env, { types: ["tombstone"] });
    await b.env.DB.prepare("UPDATE fed_peers SET enabled = 1").run();
    await only(b, h1);
    expect(await caches(b.env)).toEqual([]);
    expect(await one(b.env, "SELECT origin FROM remote_tombstones")).toEqual({ origin: "a.example" });

    // and the other way round: the stale copy first, then the removal purges it
    const [c] = await Promise.all([node("c")]);
    await follow(c, h1);
    await follow(c, h2);
    network([a, h1, h2, c]);
    await only(c, h1);
    expect((await caches(c.env)).length).toBe(1);
    await only(c, h2);
    expect(await caches(c.env)).toEqual([]);
  });

  it("two hubs that follow each other pass a record on once and serve nothing back", async () => {
    const [a, h1, h2, b] = await Promise.all([node("a"), node("h1"), node("h2"), node("b")]);
    await follow(h1, a);
    await follow(h1, h2);
    await follow(h2, h1);
    await follow(b, h1);
    await follow(b, h2);
    const log = network([a, h1, h2, b]);
    await addCache(a.env, now() - 60);
    for (let i = 0; i < 3; i++) for (const n of [h1, h2, b]) await syncAllPeers(n.env);
    const kept = (n: Node) => rows(n.env, "SELECT gid, hops, via FROM fed_transit ORDER BY gid");
    expect((await kept(h1)).map((r) => [r.hops, r.via])).toEqual([[1, "a.example"]]);
    expect((await kept(h2)).map((r) => [r.hops, r.via])).toEqual([[2, "h1.example"]]);
    expect((await kept(b)).map((r) => r.hops)).toEqual([2]);
    // another round moves nothing and serves no frame of a's: everyone holds it up to its mark
    const before = [await kept(h1), await kept(h2), await kept(b)];
    log.length = 0;
    for (const n of [h1, h2, b]) {
      const r = await syncAllPeers(n.env);
      expect(r.transit + r.caches).toBe(0);
    }
    expect(log.filter((l) => l.query.get("origin") === "a.example" && (l.frames ?? 0) > 0)).toEqual([]);
    expect([await kept(h1), await kept(h2), await kept(b)]).toEqual(before);
  });

  it("stops a record at the hop limit, and passes it on once a shorter path brings it", async () => {
    const all = { FED_RESERVE: "all" };
    const a = await node("a");
    const hubs = await Promise.all([1, 2, 3, 4].map((i) => node(`h${i}`, all)));
    const z = await node("z");
    await follow(hubs[0]!, a);
    for (let i = 1; i < 4; i++) await follow(hubs[i]!, hubs[i - 1]!);
    await follow(z, hubs[3]!);
    network([a, ...hubs, z]);
    const id = await addCache(a.env, now() - 60);
    for (const n of [...hubs, z]) await syncAllPeers(n.env);
    expect((await rows(hubs[3]!.env, "SELECT hops FROM fed_transit")).map((r) => r.hops)).toEqual([4]);
    expect(await caches(z.env)).toEqual([]); // four instances crossed: h4 keeps it and passes it on to nobody
    // h4 holds a only up to before the record it may not pass on, so a puller fills the gap elsewhere
    const summary = await call(hubs[3]!.env, "GET", "/federation/sync/summary");
    expect(summary.data.origins.find((o: { origin: string }) => o.origin === "a.example")?.held.cache ?? 0).toBe(
      (await rev(a.env, id)) - 1,
    );

    // h4 follows h1 as well: the same version over two hops replaces the four-hop copy, and z gets it
    await follow(hubs[3]!, hubs[0]!);
    await hubs[3]!.env.DB.prepare("DELETE FROM fed_origin_marks").run();
    await syncAllPeers(hubs[3]!.env);
    expect((await rows(hubs[3]!.env, "SELECT hops FROM fed_transit")).map((r) => r.hops)).toEqual([2]);
    await syncAllPeers(z.env);
    expect(await caches(z.env)).toEqual([`a.example:cache:${id}`]);
  });

  it("never asks for a blocked origin, and a hub never serves one it blocked", async () => {
    const [a, h, b] = await Promise.all([node("a"), node("h", { FED_RESERVE: "all" }), node("b")]);
    await follow(h, a);
    await follow(b, h);
    const log = network([a, h, b]);
    await addCache(a.env, now() - 60);
    await syncAllPeers(h.env);
    await syncAllPeers(b.env);
    expect((await caches(b.env)).length).toBe(1);
    expect(
      (await call(b.env, "POST", "/federation/peers/trust", { url: "transit:a.example", trust: "blocked" }, OP)).status,
    ).toBe(200);
    await addCache(a.env, now() - 30);
    await syncAllPeers(h.env);
    log.length = 0;
    await syncAllPeers(b.env);
    expect(log.filter((l) => l.query.get("origin") === "a.example")).toEqual([]);
    expect((await caches(b.env)).length).toBe(1);

    // the hub blocks a: its summary drops it and its pages refuse it, FED_RESERVE=all or not
    expect((await call(h.env, "POST", "/federation/peers/trust", { url: a.url, trust: "blocked" }, OP)).status).toBe(
      200,
    );
    const summary = await call(h.env, "GET", "/federation/sync/summary");
    expect(summary.data.origins.map((o: { origin: string }) => o.origin)).toEqual(["h.example"]);
    const page = await serve(h.env)(new Request(`${h.url}/federation/sync/origin?origin=a.example&kind=cache&since=0`));
    expect(page.status).toBe(404);
  });

  it("narrows caches to the region, reads them again when it widens, and a narrower hub moves no mark", async () => {
    const [a, h, b] = await Promise.all([node("a"), node("h"), node("b", { FED_SYNC_REGION: GRAZ })]);
    await follow(h, a);
    await follow(b, h);
    network([a, h, b]);
    const at = async (lat: number, lon: number) => {
      const r = await a.env.DB.prepare(
        `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at)
         VALUES (?, 'OE8APR', 'c', 'traditional', ?, ?, 1000, 1000)`,
      )
        .bind(`AC-G${lat}`, lat, lon)
        .run();
      return Number(r.meta.last_row_id);
    };
    const graz = await at(47.07, 15.42);
    const vienna = await at(48.21, 16.37);
    await syncAllPeers(h.env);
    await syncAllPeers(b.env);
    expect(await caches(b.env)).toEqual([`a.example:cache:${graz}`]);
    expect(await one(b.env, "SELECT region FROM fed_origin_marks WHERE kind = 'cache'")).toEqual({ region: GRAZ });

    (b.env as { FED_SYNC_REGION?: string }).FED_SYNC_REGION = undefined;
    await syncAllPeers(b.env);
    expect(await caches(b.env)).toEqual([`a.example:cache:${graz}`, `a.example:cache:${vienna}`].sort());
    expect(await one(b.env, "SELECT region FROM fed_origin_marks WHERE kind = 'cache'")).toEqual({ region: "" });

    // a hub that holds only its region passes those caches on, and promises a whole-feed reader nothing
    const [h2, c] = await Promise.all([node("h2", { FED_SYNC_REGION: GRAZ }), node("c")]);
    await follow(h2, a);
    await follow(c, h2);
    network([a, h2, c]);
    await syncAllPeers(h2.env);
    await syncAllPeers(c.env);
    expect(await caches(c.env)).toEqual([`a.example:cache:${graz}`]);
    expect(await mark(c.env, "cache")).toBe(0);
  });
});

describe("a spoke that pushes", () => {
  it("is held by its hub as far as its pages join up, and passed on like any origin", async () => {
    const SUBMIT = "submit-secret";
    const [hub, b] = await Promise.all([node("hub", { FED_SUBMIT_SECRET: SUBMIT, FED_RESERVE: "all" }), node("b")]);
    const s = await node("s", { FED_HUB_URL: hub.url, FED_SUBMIT_SECRET: SUBMIT });
    await follow(b, hub);
    network([hub, b]);
    const id = await addCache(s.env, now() - 60);
    await pushToHub(s.env);
    expect(await mark(hub.env, "cache", "s.example")).toBe(await rev(s.env, id));
    await syncAllPeers(b.env);
    expect(await caches(b.env, "s.example")).toEqual([`s.example:cache:${id}`]);

    // a page that does not say where it starts moves no mark
    const later = await addCache(s.env, now() - 30);
    const { encodeFedSyncPage, buildFedFrames } = await import("@aprscaching/gateway/fedsync");
    const built = (await buildFedFrames(s.env, "s.example", "cache", await rev(s.env, id), 500))!;
    const res = await serve(hub.env)(
      new Request(`${hub.url}/federation/submit`, {
        method: "POST",
        headers: { "content-type": "application/cbor", "x-fed-secret": SUBMIT },
        body: encodeFedSyncPage("s.example", built.nextCursor, true, built.frames) as BodyInit,
      }),
    );
    expect(res.status).toBe(200);
    expect(await mark(hub.env, "cache", "s.example")).toBe(await rev(s.env, id));
    expect(await rev(s.env, later)).toBeGreaterThan(await rev(s.env, id));
  });
});

describe("a Pocket station carries records", () => {
  it("from A to C, which never meet: C holds them under A's key, and A's later deletion follows the same way", async () => {
    const [a, m, c] = await Promise.all([node("a"), node("m"), node("c")]);
    // the station M follows home A, trusted by its fingerprint; C follows M, never A
    await follow(m, a);
    await follow(c, m);
    const cacheId = await addCache(a.env, now() - 60);
    const find = await a.env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, 'OE8FND', ?, 'found', 0)",
    )
      .bind(cacheId, now() - 30)
      .run();
    const findId = Number(find.meta.last_row_id);

    // at home: only A and M can reach each other
    network([a, m]);
    await syncAllPeers(m.env);
    expect((await caches(m.env)).length).toBe(1);

    // at the field event: only M and C, no internet to A
    const log = network([m, c]);
    const r = await syncAllPeers(c.env);
    expect(r.errors).toEqual([]);
    expect(await caches(c.env)).toEqual([`a.example:cache:${cacheId}`]);
    expect(await one(c.env, "SELECT origin FROM remote_finds")).toEqual({ origin: "a.example" });
    // signed by A, verified under A's key, which M handed on; A is unvetted at C, as through any hub
    expect(
      (await rows(c.env, "SELECT signer_key, via, hops FROM fed_transit ORDER BY gid")).map((x) => [
        x.signer_key,
        x.via,
        x.hops,
      ]),
    ).toEqual([
      [a.key.pub, "m.example", 2],
      [a.key.pub, "m.example", 2],
    ]);
    expect(await one(c.env, "SELECT url, trust, public_key FROM fed_peers WHERE instance = 'a.example'")).toEqual({
      url: "transit:a.example",
      trust: "unvetted",
      public_key: a.key.pub,
    });
    const fp = (await call(c.env, "GET", "/federation/peers", undefined, OP)).data.peers.find(
      (p: { instance: string }) => p.instance === "a.example",
    ).fingerprint;
    expect(fp).toBe(fingerprint(a.key));

    // A erases the find and the cache; M carries the deletions the next time it meets each
    await a.env.DB.prepare(
      "INSERT INTO tombstones (id, kind, target_id, origin, ts) VALUES ('t1', 'cache', ?, 'a.example', ?), ('t2', 'find', ?, 'a.example', ?)",
    )
      .bind(`a.example:cache:${cacheId}`, now(), `a.example:find:${findId}`, now())
      .run();
    network([a, m]);
    await syncAllPeers(m.env);
    log.length = 0;
    network([m, c], log);
    await syncAllPeers(c.env);
    expect(await caches(c.env)).toEqual([]);
    expect(await rows(c.env, "SELECT global_id FROM remote_finds")).toEqual([]);
    // C asked M for the deletions alone: the caches and finds it holds were not read again
    expect(log.filter((l) => l.query.get("kind") !== "tombstone" && l.query.get("origin") === "a.example")).toEqual([]);
  });

  it("carries the records of origins it never vetted when FED_RESERVE is all", async () => {
    const [a, m, c] = await Promise.all([node("a"), node("m", { FED_RESERVE: "all" }), node("c")]);
    await follow(m, a, "unvetted");
    await follow(c, m);
    await addCache(a.env, now() - 60);
    network([a, m]);
    await syncAllPeers(m.env);
    network([m, c]);
    await syncAllPeers(c.env);
    expect((await caches(c.env)).length).toBe(1);
  });

  it("from a station C does not trust: the records apply, and its word moves no mark", async () => {
    const [a, m, c] = await Promise.all([node("a"), node("m"), node("c")]);
    await follow(m, a);
    await follow(c, m, "unvetted");
    await addCache(a.env, now() - 60);
    network([a, m]);
    await syncAllPeers(m.env);
    network([m, c]);
    await syncAllPeers(c.env);
    expect((await caches(c.env)).length).toBe(1);
    expect(await mark(c.env, "cache")).toBe(0);
  });
});
