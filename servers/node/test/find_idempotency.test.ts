// SPDX-License-Identifier: AGPL-3.0-or-later
// SR-TRUST-04: the partial unique index (migration 0008) makes a verified find idempotent per
// (cache_id, logger_call) — a racing/replayed found POST can't double-insert (and thus can't
// double-count on the leaderboard). Runs against real SQLite so it exercises the actual index.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/migrate.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

function freshDb() {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

const insertFound = (db: Database.Database, cacheId: number, logger: string) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method) VALUES (?,?,?, 'found', 1, 'B', 'app_geo')",
    )
    .run(cacheId, logger, 1000).changes;

describe("SR-TRUST-04 — find-log idempotency", () => {
  it("a second found for the same (cache, logger) is ignored", () => {
    const db = freshDb();
    expect(insertFound(db, 1, "DL1ABC")).toBe(1); // first lands
    expect(insertFound(db, 1, "DL1ABC")).toBe(0); // replay ignored (unique index)
    const n = db.prepare("SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id=1 AND logger_call='DL1ABC'").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  it("different loggers and different caches are independent", () => {
    const db = freshDb();
    expect(insertFound(db, 1, "DL1ABC")).toBe(1);
    expect(insertFound(db, 1, "OE3XYZ")).toBe(1); // different logger, same cache → allowed
    expect(insertFound(db, 2, "DL1ABC")).toBe(1); // same logger, different cache → allowed
  });

  it("the index only constrains found — dnf/note can repeat", () => {
    const db = freshDb();
    const dnf = () =>
      db
        .prepare(
          "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (1,'DL1ABC',1000,'dnf',0)",
        )
        .run().changes;
    expect(dnf()).toBe(1);
    expect(dnf()).toBe(1); // a second DNF is fine (partial index is WHERE log_type='found')
  });
});
