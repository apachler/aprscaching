// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared self-host migration runner, over a recording fake driver.
import { describe, it, expect } from "vitest";
import { migrate, type MigrationTarget } from "../src/migrate.js";

function fakeDb(applied: string[] = [], failOn?: string) {
  const log: string[] = [];
  const recorded = [...applied];
  const db: MigrationTarget = {
    exec(sql) {
      if (failOn && sql === failOn) throw new Error("boom");
      log.push(sql);
    },
    query(sql, ...params) {
      if (sql.startsWith("SELECT name")) return recorded.map((name) => ({ name }));
      recorded.push(String(params[0]));
      log.push(`record ${params[0]}`);
      return [];
    },
  };
  return { db, log, recorded };
}

describe("migrate", () => {
  it("applies pending migrations in name order, each in its own transaction", () => {
    const { db, log } = fakeDb(["0001_a.sql"]);
    const ran = migrate(db, [
      { name: "0003_c.sql", sql: "C" },
      { name: "0001_a.sql", sql: "A" },
      { name: "0002_b.sql", sql: "B" },
    ]);
    expect(ran).toEqual(["0002_b.sql", "0003_c.sql"]);
    expect(log.slice(1)).toEqual([
      "BEGIN",
      "B",
      "record 0002_b.sql",
      "COMMIT",
      "BEGIN",
      "C",
      "record 0003_c.sql",
      "COMMIT",
    ]);
  });

  it("is a no-op when everything is applied", () => {
    const { db } = fakeDb(["0001_a.sql"]);
    expect(migrate(db, [{ name: "0001_a.sql", sql: "A" }])).toEqual([]);
  });

  it("rolls back and names the migration that failed", () => {
    const { db, log, recorded } = fakeDb([], "BAD");
    expect(() => migrate(db, [{ name: "0001_bad.sql", sql: "BAD" }])).toThrow(/migration 0001_bad.sql failed: boom/);
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(recorded).toEqual([]);
  });
});
