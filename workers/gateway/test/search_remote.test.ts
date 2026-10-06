// SPDX-License-Identifier: AGPL-3.0-or-later
// Search reaches the caches mirrored from federation peers under the map's trust policy, and names each one's
// home instance, so a peer's AC-0001 never reads as this instance's AC-0001. The handler runs over a real
// SQLite database holding the baseline schema.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { handleSearch } from "../src/search.js";
import { originWebUrl } from "../src/caches.js";
import type { Env } from "../src/env.js";
import type { SearchResults } from "@aprscaching/shared";

const BASELINE = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0001_baseline.sql", import.meta.url)),
  "utf8",
);

/** The gateway's statement surface over node:sqlite, enough for the search handler. */
function sqlDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(BASELINE);
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    async run() {
      const r = db.prepare(sql).run(...(params as never[]));
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async all() {
      return { results: db.prepare(sql).all(...(params as never[])), meta: {} };
    },
    async first() {
      return db.prepare(sql).get(...(params as never[])) ?? null;
    },
  });
  return { raw: db, prepare: (sql: string) => stmt(sql) };
}

let db: ReturnType<typeof sqlDb>;
let env: Env;
beforeEach(() => {
  db = sqlDb();
  env = { DB: db, INSTANCE: "here.example" } as unknown as Env;
  db.raw
    .prepare(
      `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at)
       VALUES ('AC-0001', 'OE8APR', 'Local riverwalk', 'traditional', 47.0, 15.4, 1, 1)`,
    )
    .run();
  const peer = db.raw.prepare("INSERT INTO fed_peers (url, instance, trust) VALUES (?, ?, ?)");
  peer.run("https://trusted.example", "trusted.example", "trusted");
  peer.run("https://unvetted.example", "unvetted.example", "unvetted");
  peer.run("https://blocked.example", "blocked.example", "blocked");
  const remote = db.raw.prepare(
    `INSERT INTO remote_caches (global_id, origin, code, owner_call, title, type, status, difficulty, terrain, lat, lon, mirrored_at)
     VALUES (?, ?, 'AC-0001', 'OE3ABC', ?, 'traditional', 'active', 1.5, 2, 48.2, 16.4, 1)`,
  );
  remote.run("trusted.example:cache:1", "trusted.example", "Peer riverwalk");
  remote.run("unvetted.example:cache:1", "unvetted.example", "Unvetted riverwalk");
  remote.run("blocked.example:cache:1", "blocked.example", "Blocked riverwalk");
});

const search = async (q: string, extra = "") =>
  (await (
    await handleSearch(new Request(`https://here.example/api/search?q=${encodeURIComponent(q)}${extra}`), env)
  ).json()) as SearchResults;

describe("search over mirrored caches", () => {
  it("lists this instance's cache first, then a trusted peer's, with its home instance", async () => {
    const r = await search("riverwalk");
    expect(r.caches.map((c) => c.title)).toEqual(["Local riverwalk", "Peer riverwalk"]);
    const [local, peer] = r.caches;
    expect(local!.id).toBeTypeOf("number");
    expect(local!.remote).toBeUndefined();
    expect(peer!.id).toBeNull();
    expect(peer!.code).toBe("AC-0001");
    expect(peer!.remote).toMatchObject({
      origin: "trusted.example",
      originUrl: "https://trusted.example",
      mirrored: true,
      originTrust: "trusted",
    });
  });

  it("adds an unvetted origin's caches only when asked, and never a blocked one's", async () => {
    const r = await search("riverwalk", "&includeUnvetted=1");
    expect(r.caches.map((c) => c.remote?.origin ?? "here")).toEqual(["here", "trusted.example", "unvetted.example"]);
  });

  it("keeps the limit across both kinds", async () => {
    const r = await search("riverwalk", "&limit=1");
    expect(r.caches.map((c) => c.title)).toEqual(["Local riverwalk"]);
  });
});

describe("a mirrored cache's home link", () => {
  it("is the peer's web address without trailing slashes", () => {
    expect(originWebUrl("https://peer.example///")).toBe("https://peer.example");
    expect(originWebUrl("HTTP://peer.example/base/")).toBe("HTTP://peer.example/base");
  });

  it("is nothing for an address that is not on the web, has no host, or is too long", () => {
    expect(originWebUrl("44net://peer")).toBeNull();
    expect(originWebUrl("https:////")).toBeNull();
    expect(originWebUrl(null)).toBeNull();
    expect(originWebUrl(`https://peer.example/${"a".repeat(3000)}`)).toBeNull();
  });

  it("takes linear time on a hostile run of slashes", () => {
    const hostile = `https://${"/".repeat(2000)}x${"/".repeat(30)}`;
    const t = performance.now();
    for (let i = 0; i < 1000; i++) originWebUrl(hostile);
    expect(performance.now() - t).toBeLessThan(500);
    expect(originWebUrl(hostile)).toBe(hostile.slice(0, hostile.length - 30));
    expect(originWebUrl(`https://${"/".repeat(100_000)}`)).toBeNull();
  });
});
