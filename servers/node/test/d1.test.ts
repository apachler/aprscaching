// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, n INTEGER)");
  return makeD1(sqlite);
}

describe("D1-compatible SQLite shim", () => {
  it("run() reports last_row_id and changes like D1", async () => {
    const db = freshDb();
    const r = await db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("a", 1).run();
    expect(r.meta.last_row_id).toBe(1);
    expect(r.meta.changes).toBe(1);
  });

  it("first() returns a row or null", async () => {
    const db = freshDb();
    await db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("a", 5).run();
    const row = await db.prepare("SELECT * FROM t WHERE name = ?").bind("a").first<{ n: number }>();
    expect(row?.n).toBe(5);
    const none = await db.prepare("SELECT * FROM t WHERE name = ?").bind("nope").first();
    expect(none).toBeNull();
  });

  it("all() returns { results }", async () => {
    const db = freshDb();
    await db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("a", 1).run();
    await db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("b", 2).run();
    const res = await db.prepare("SELECT * FROM t ORDER BY n").all<{ name: string }>();
    expect(res.results.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("SR-RT-08: throws on an undefined bind (Cloudflare D1 parity), coerces boolean -> 0/1", () => {
    const db = freshDb();
    // real D1 rejects an undefined bind with D1_TYPE_ERROR — the shim must too, so a latent bug
    // fails on Node/Bun in CI instead of only 500-ing on Workers.
    expect(() => db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind(undefined, 1)).toThrow(/D1_TYPE_ERROR/);
  });

  it("coerces boolean -> 0/1 (a convenience beyond D1)", async () => {
    const db = freshDb();
    await db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("a", true).run();
    const row = await db.prepare("SELECT name, n FROM t").first<{ name: string | null; n: number }>();
    expect(row?.n).toBe(1);
  });

  it("SR-RT-09: a RETURNING writer carries real changes()/last_insert_rowid() meta", async () => {
    const db = freshDb();
    const r = await db.prepare("INSERT INTO t (name, n) VALUES (?, ?) RETURNING id").bind("z", 7).run();
    expect(r.results).toHaveLength(1); // rows came back
    expect(r.meta.changes).toBe(1); // …and meta reflects the write (was zeroed before)
    expect(r.meta.last_row_id).toBe(1);
    // a plain SELECT still reports zeroed meta, as D1 does
    const sel = await db.prepare("SELECT * FROM t").all();
    expect(sel.meta.changes).toBe(0);
  });

  it("batch() runs statements atomically in a transaction", async () => {
    const db = freshDb();
    const res = await db.batch([
      db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("x", 1),
      db.prepare("UPDATE t SET n = ? WHERE name = ?").bind(9, "x"),
    ]);
    expect(res).toHaveLength(2);
    const row = await db.prepare("SELECT n FROM t WHERE name = ?").bind("x").first<{ n: number }>();
    expect(row?.n).toBe(9);
  });
});
