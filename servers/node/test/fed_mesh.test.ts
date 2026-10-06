// SPDX-License-Identifier: AGPL-3.0-or-later
// The federation mesh: every instance tracks what it holds per origin, so any neighbour fills a gap, a pull
// switches paths without reading again what it holds, and a record carried by a phone that met one instance
// reaches the next one, signed by its origin. Real gateways throughout, each over its own SQLite database.
import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { pushToHub, syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { decodeFedSyncPage } from "@aprscaching/gateway/fedsync";
import { call } from "./helpers/authflow.js";
import { addCache, gid, instanceEnv, newFedKey, serve, stubFetch, type FedKey, type Serve } from "./helpers/fedpeer.js";
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
    expect(await caches(b.env)).toEqual([await gid(a.env, "cache", c1)]);
    expect(await mark(b.env, "cache")).toBe(await rev(a.env, c1));

    // a second cache, which only h2 holds
    const c2 = await addCache(a.env, now() - 30);
    await syncAllPeers(h2.env);
    log.length = 0;
    const r = await only(b, h1, h2);
    expect(r.errors).toEqual([]);
    expect(await caches(b.env)).toEqual([await gid(a.env, "cache", c1), await gid(a.env, "cache", c2)]);
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
    expect(await caches(b.env)).toContain(await gid(a.env, "cache", c6));
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

  it("stops a record at the hop limit, and fills the gap once a shorter path brings it, marks untouched", async () => {
    const all = { FED_RESERVE: "all" };
    const a = await node("a");
    const hubs = await Promise.all([1, 2, 3, 4].map((i) => node(`h${i}`, all)));
    const [h1, , , h4] = hubs as [Node, Node, Node, Node];
    const z = await node("z");
    await follow(h1, a);
    for (let i = 1; i < 4; i++) await follow(hubs[i]!, hubs[i - 1]!);
    await follow(z, h4);
    network([a, ...hubs, z]);
    const c1 = await addCache(a.env, now() - 60);
    for (const n of [...hubs, z]) await syncAllPeers(n.env);
    expect((await rows(h4.env, "SELECT hops FROM fed_transit")).map((r) => r.hops)).toEqual([4]);
    expect(await caches(z.env)).toEqual([]); // four instances crossed: h4 keeps it and passes it on to nobody
    // h4's mark moves on; the record it may not pass on is a gap it asks its neighbours for, and its pages name it
    expect(await mark(h4.env, "cache")).toBe(await rev(a.env, c1));
    expect(await rows(h4.env, "SELECT v, reason FROM fed_origin_gaps")).toEqual([
      { v: await rev(a.env, c1), reason: "hops" },
    ]);

    // h4 follows h1 as well, and a writes a second cache: h4 asks h1 for the gap, the first cache comes over two
    // hops and replaces the four-hop copy, and z gets both, the first at its next try for the gap h4 named
    await follow(h4, h1);
    const c2 = await addCache(a.env, now() - 30);
    for (const n of [h1, ...hubs.slice(1), z]) await syncAllPeers(n.env);
    expect(await rows(h4.env, "SELECT v FROM fed_origin_gaps")).toEqual([]);
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_000);
    await syncAllPeers(z.env);
    later.mockRestore();
    expect((await rows(h4.env, "SELECT gid, hops FROM fed_transit ORDER BY gid")).map((r) => r.hops)).toEqual([2, 2]);
    expect(await mark(h4.env, "cache")).toBe(await rev(a.env, c2));
    expect(await caches(z.env)).toEqual([await gid(a.env, "cache", c1), await gid(a.env, "cache", c2)].sort());
    expect(await mark(z.env, "cache")).toBe(await rev(a.env, c2));
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
    expect(await caches(b.env)).toEqual([await gid(a.env, "cache", graz)]);
    expect(await one(b.env, "SELECT region FROM fed_origin_marks WHERE kind = 'cache'")).toEqual({ region: GRAZ });

    (b.env as { FED_SYNC_REGION?: string }).FED_SYNC_REGION = undefined;
    await syncAllPeers(b.env);
    expect(await caches(b.env)).toEqual([await gid(a.env, "cache", graz), await gid(a.env, "cache", vienna)].sort());
    expect(await one(b.env, "SELECT region FROM fed_origin_marks WHERE kind = 'cache'")).toEqual({ region: "" });

    // a hub that holds only its region passes those caches on, and promises a whole-feed reader nothing
    const [h2, c] = await Promise.all([node("h2", { FED_SYNC_REGION: GRAZ }), node("c")]);
    await follow(h2, a);
    await follow(c, h2);
    const log = network([a, h2, c]);
    await syncAllPeers(h2.env);
    await syncAllPeers(c.env);
    expect(await caches(c.env)).toEqual([await gid(a.env, "cache", graz)]);
    expect(await mark(c.env, "cache")).toBe(0);
    // and c does not read them again at every pass: it asks past where it read, and h2 has nothing there
    log.length = 0;
    await syncAllPeers(c.env);
    expect(cachePages(log, "h2.example")).toEqual([]);
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
    expect(await caches(b.env, "s.example")).toEqual([await gid(s.env, "cache", id)]);

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

    // the hub forgets what it held of the spoke: the spoke's next page does not join up, the hub answers how far
    // it holds the spoke, and the spoke sends again from there
    await hub.env.DB.prepare("DELETE FROM fed_origin_marks WHERE origin = 's.example'").run();
    const third = await addCache(s.env, now() - 10);
    await pushToHub(s.env);
    expect(await mark(hub.env, "cache", "s.example")).toBe(await rev(s.env, third));
  });
});

describe("what moves a mark", () => {
  it("not a frame signed ahead of this clock, until the clock catches up", async () => {
    const [a, b] = await Promise.all([node("a"), node("b")]);
    await follow(b, a);
    const id = await addCache(a.env, now() - 60);
    // a page a signed now, read by b while b's clock is an hour behind
    const real = Date.now();
    const page = await (
      await serve(a.env)(new Request(`${a.url}/federation/sync/origin?origin=a.example&kind=cache&since=0`))
    ).arrayBuffer();
    const log: Log = [];
    stubFetch({
      [a.url]: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/federation/sync/origin" && u.searchParams.get("kind") === "cache") {
          log.push({ at: a.name, path: u.pathname, query: u.searchParams });
          return new Response(page, { headers: { "content-type": "application/cbor" } });
        }
        return serve(a.env)(req);
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(real - 3_600_000);
    await syncAllPeers(b.env);
    expect(await caches(b.env)).toEqual([]);
    // the mark moves on, and the record that did not settle is a gap, asked for on its own
    const v = await rev(a.env, id);
    expect(await rows(b.env, "SELECT v, reason FROM fed_origin_gaps")).toEqual([{ v, reason: "unsettled" }]);
    clock.mockRestore();
    log.length = 0;
    await syncAllPeers(b.env);
    // one record asked for, not the feed again
    expect(log.map((l) => [l.query.get("since"), l.query.get("limit")])).toEqual([[String(v - 1), "1"]]);
    expect(await rows(b.env, "SELECT v FROM fed_origin_gaps")).toEqual([]);
    expect(await caches(b.env)).toEqual([await gid(a.env, "cache", id)]);
    expect(await mark(b.env, "cache")).toBe(await rev(a.env, id));
  });

  it("not a record the database refused for now, which the next pass applies", async () => {
    const [a, b] = await Promise.all([node("a"), node("b")]);
    await follow(b, a);
    network([a, b]);
    const id = await addCache(a.env, now() - 60);
    const db = b.env.DB as unknown as { prepare: (sql: string) => unknown };
    const prepare = db.prepare.bind(db);
    let busy = true;
    db.prepare = (sql: string) => {
      if (busy && sql.includes("INSERT INTO remote_caches")) throw new Error("SQLITE_BUSY: database is locked");
      return prepare(sql);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncAllPeers(b.env);
    expect(await caches(b.env)).toEqual([]);
    expect(await rows(b.env, "SELECT reason FROM fed_origin_gaps")).toEqual([{ reason: "unsettled" }]);
    busy = false;
    // asked again once the backoff has passed
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_000);
    await syncAllPeers(b.env);
    later.mockRestore();
    warn.mockRestore();
    expect(await caches(b.env)).toEqual([await gid(a.env, "cache", id)]);
    expect(await mark(b.env, "cache")).toBe(await rev(a.env, id));
  });

  it("past a frame that never settles on a trusted hub, which is asked for alone and given up after a week", async () => {
    const [a, h, b] = await Promise.all([node("a"), node("h"), node("b")]);
    await follow(h, a);
    await follow(b, h);
    const log = network([a, h, b]);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await addCache(a.env, now() - 60));
    await syncAllPeers(h.env);
    // one frame h keeps is damaged: it never verifies, wherever it goes
    const bad = await rev(a.env, ids[2]!);
    const kept = await one(h.env, "SELECT frame FROM fed_transit WHERE v = ?", bad);
    const frame = new Uint8Array(kept!.frame as Uint8Array);
    frame[frame.length - 1] = frame[frame.length - 1]! ^ 0xff;
    await h.env.DB.prepare("UPDATE fed_transit SET frame = ? WHERE v = ?").bind(frame, bad).run();
    await syncAllPeers(b.env);
    expect((await caches(b.env)).length).toBe(4);
    expect(await mark(b.env, "cache")).toBe(await rev(a.env, ids[4]!));
    expect(await rows(b.env, "SELECT v, reason FROM fed_origin_gaps")).toEqual([{ v: bad, reason: "unsettled" }]);
    // the next passes read nothing again; after the backoff the one record is asked for, and nothing more
    log.length = 0;
    await syncAllPeers(b.env);
    expect(cachePages(log, "h.example")).toEqual([]);
    const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(Date.now() + ms);
    let clock = at(600_000);
    await syncAllPeers(b.env);
    clock.mockRestore();
    expect(cachePages(log, "h.example").map((l) => [l.query.get("since"), l.query.get("limit")])).toEqual([
      [String(bad - 1), "1"],
    ]);

    // a week on, nobody filled it: it is given up, listed once for the sysop, and leaves the list when seen
    clock = at(8 * 86_400_000);
    await syncAllPeers(b.env);
    clock.mockRestore();
    expect(await rows(b.env, "SELECT v FROM fed_origin_gaps")).toEqual([]);
    const peers = await call(b.env, "GET", "/federation/peers", undefined, OP);
    expect(peers.data.givenUp).toEqual({
      count: 1,
      gaps: [expect.objectContaining({ origin: "a.example", kind: "cache", v: bad, reason: "unsettled" })],
    });
    expect((await call(b.env, "POST", "/federation/gaps/seen", {}, OP)).data).toEqual({ ok: true, seen: 1 });
    expect((await call(b.env, "GET", "/federation/peers", undefined, OP)).data.givenUp.count).toBe(0);
  });

  it("only forward, and never for a generation of the origin's marks that was forgotten", async () => {
    const { markGen, setMark } = await import("@aprscaching/gateway/fedtransit");
    const b = await node("b");
    const gen = await markGen(b.env, "a.example");
    await setMark(b.env, "a.example", "cache", 10, gen);
    await setMark(b.env, "a.example", "cache", 5, gen);
    expect(await mark(b.env, "cache")).toBe(10);
    // forgotten meanwhile (a key a hub handed on replaced): a pull that read the old generation moves nothing
    await b.env.DB.prepare("INSERT INTO fed_mark_gen (origin, gen) VALUES ('a.example', 1)").run();
    await b.env.DB.prepare("DELETE FROM fed_origin_marks").run();
    await setMark(b.env, "a.example", "cache", 20, gen);
    expect(await mark(b.env, "cache")).toBe(0);
  });
});

describe("a long chain", () => {
  it("reads past one page budget a pass, the hop limit and all, and never starts over", async () => {
    const all = { FED_RESERVE: "all" };
    const a = await node("a");
    const hubs = await Promise.all([1, 2, 3, 4].map((i) => node(`h${i}`, all)));
    await follow(hubs[0]!, a);
    for (let i = 1; i < 4; i++) await follow(hubs[i]!, hubs[i - 1]!);
    const log = network([a, ...hubs]);
    for (let i = 0; i < 1200; i++) await addCache(a.env, 5000);
    for (const n of hubs.slice(0, 3)) await syncAllPeers(n.env);
    const h4 = hubs[3]!;
    const counts: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      log.length = 0;
      await syncAllPeers(h4.env, { maxPages: 1 });
      counts.push(((await one(h4.env, "SELECT COUNT(*) AS n FROM remote_caches")) as { n: number }).n);
      // every pass reads on from where the last one stopped, never from the start
      if (pass > 0) expect(cachePages(log, "h3.example").filter((x) => x.query.get("since") === "0")).toEqual([]);
    }
    expect(counts).toEqual([500, 1000, 1200, 1200]);
    const top = (await one(a.env, "SELECT n FROM fed_seq WHERE kind = 'cache'"))!.n as number;
    expect(await mark(h4.env, "cache")).toBe(top);
  }, 30_000);
});

describe("a restored origin", () => {
  it("numbers its new records above what peers hold, under global ids nobody holds or deleted", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { makeD1 } = await import("../src/d1.js");
    const { freshDb } = await import("./helpers/fedpeer.js");
    const key = await newFedKey();
    const { sqlite } = freshDb();
    const a: Node = {
      name: "a.example",
      url: "https://a.example",
      env: instanceEnv("a.example", key, {}, makeD1(sqlite)),
      key,
    };
    const b = await node("b");
    await follow(b, a);
    network([a, b]);
    const titled = async (env: Env, title: string) => {
      const id = await addCache(env, now() - 60);
      await env.DB.prepare("UPDATE caches SET title = ? WHERE id = ?").bind(title, id).run();
      return id;
    };
    const first = await titled(a.env, "Before the backup");
    const backup = sqlite.serialize(); // the backup, taken now
    const lost = await titled(a.env, "Lost with the restore");
    const kept = await titled(a.env, "Kept by the peers");
    // the lost cache is erased for good: the peers keep a tombstone for it
    const lostGid = await gid(a.env, "cache", lost);
    await a.env.DB.prepare("DELETE FROM caches WHERE id = ?").bind(lost).run();
    await a.env.DB.prepare(
      "INSERT INTO tombstones (id, kind, target_id, origin, ts) VALUES ('t-lost', 'cache', ?, 'a.example', ?)",
    )
      .bind(lostGid, now())
      .run();
    await syncAllPeers(b.env);
    const keptGid = await gid(a.env, "cache", kept);
    expect((await caches(b.env)).sort()).toEqual([await gid(a.env, "cache", first), keptGid].sort());
    const held = await mark(b.env, "cache");

    // a is restored from the backup: its counters and its row ids go back with it
    await new Promise((r) => setTimeout(r, 5));
    const restored = instanceEnv("a.example", key, {}, makeD1(new Database(backup)));
    network([{ ...a, env: restored }, b]);
    const fresh = await titled(restored, "New after the restore");
    const fresh2 = await titled(restored, "Second after the restore");
    expect([fresh, fresh2]).toEqual([lost, kept]); // the row ids come round again
    expect(await rev(restored, fresh)).toBeGreaterThan(held);
    await restored.DB.prepare(
      "INSERT INTO tombstones (id, kind, target_id, origin, ts) VALUES ('t-first', 'cache', ?, 'a.example', ?)",
    )
      .bind(await gid(restored, "cache", first), now())
      .run();
    await syncAllPeers(b.env);
    const title = async (g: string) =>
      (await one(b.env, "SELECT title FROM remote_caches WHERE global_id = ?", g))?.title ?? null;
    // the new caches arrive under global ids of their own, the lost cache's tombstone suppresses neither, the
    // peers' copy of the kept cache is not overwritten, and the restored origin's deletion reaches them
    expect(await title(await gid(restored, "cache", fresh))).toBe("New after the restore");
    expect(await title(await gid(restored, "cache", fresh2))).toBe("Second after the restore");
    expect(await title(keptGid)).toBe("Kept by the peers");
    expect(await title(await gid(a.env, "cache", first))).toBeNull();
    expect(await gid(restored, "cache", fresh)).not.toBe(lostGid);

    // and a trusted peer that holds more of a than a itself does raises a's counters when a pulls it
    await follow({ ...a, env: restored }, b);
    await restored.DB.prepare("UPDATE fed_seq SET n = 1 WHERE kind = 'cache'").run();
    await syncAllPeers(restored);
    const n = (await one(restored, "SELECT n FROM fed_seq WHERE kind = 'cache'"))!.n as number;
    expect(n).toBeGreaterThanOrEqual(await mark(b.env, "cache"));
  });

  it("takes a neighbour's word on its own numbering only when it trusts that neighbour", async () => {
    const [a, b] = await Promise.all([node("a"), node("b")]);
    await follow(b, a);
    await follow(a, b, "unvetted");
    network([a, b]);
    await addCache(a.env, now() - 60);
    await syncAllPeers(b.env);
    await a.env.DB.prepare("UPDATE fed_seq SET n = 1 WHERE kind = 'cache'").run();
    await syncAllPeers(a.env);
    expect((await one(a.env, "SELECT n FROM fed_seq WHERE kind = 'cache'"))!.n).toBe(1);
  });
});

describe("a summary that names many origins", () => {
  it("teaches at most 50 new keys per pull", async () => {
    const [h, b] = await Promise.all([node("h"), node("b")]);
    await follow(b, h);
    const origins = await Promise.all(
      Array.from({ length: 120 }, async (_, i) => ({
        origin: `o${String(i).padStart(3, "0")}.example`,
        held: { cache: 1 },
        top: { cache: 1 },
        publicKey: (await newFedKey()).pub,
      })),
    );
    stubFetch({
      [h.url]: async (req) =>
        new URL(req.url).pathname === "/federation/sync/summary"
          ? Response.json({ instance: h.name, origins, complete: true })
          : serve(h.env)(req),
    });
    await syncAllPeers(b.env);
    expect((await one(b.env, "SELECT COUNT(*) AS n FROM fed_peers WHERE added_via = 'transit'"))!.n).toBe(50);
    await syncAllPeers(b.env);
    expect((await one(b.env, "SELECT COUNT(*) AS n FROM fed_peers WHERE added_via = 'transit'"))!.n).toBe(100);
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
    expect(await caches(c.env)).toEqual([await gid(a.env, "cache", cacheId)]);
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
      .bind(await gid(a.env, "cache", cacheId), now(), await gid(a.env, "find", findId), now())
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
