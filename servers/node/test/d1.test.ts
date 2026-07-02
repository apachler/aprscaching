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

  it("coerces undefined -> NULL and boolean -> 0/1", async () => {
    const db = freshDb();
    await db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind(undefined, true).run();
    const row = await db.prepare("SELECT name, n FROM t").first<{ name: string | null; n: number }>();
    expect(row?.name).toBeNull();
    expect(row?.n).toBe(1);
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
