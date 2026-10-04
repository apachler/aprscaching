// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The gateway's database over Bun's built-in `bun:sqlite`: the shared adapter
 * (servers/node/src/d1.ts, d1Over) on a bun:sqlite driver, so the same business logic runs unchanged
 * on Node+SQLite and Bun+bun:sqlite.
 */
import { Database } from "bun:sqlite";
import type { SqlDatabase, SqlStatement, SqlResult } from "@aprscaching/gateway/runtime";
import { d1Over } from "../node/src/d1.ts";

/** SqlDatabase backed by bun:sqlite. Accepts a path (opens it) or an existing Database. */
export class BunDb implements SqlDatabase {
  readonly raw: Database;
  private readonly d1: SqlDatabase;
  constructor(pathOrDb: string | Database) {
    this.raw = typeof pathOrDb === "string" ? new Database(pathOrDb, { create: true }) : pathOrDb;
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    const raw = this.raw;
    this.d1 = d1Over({
      prepare(sql) {
        const q = raw.query(sql);
        return {
          // a row-returning statement (SELECT / PRAGMA table_info / … / INSERT … RETURNING) has columns
          reader: q.columnNames.length > 0,
          all: (...p) => q.all(...(p as never[])),
          get: (...p) => q.get(...(p as never[])),
          run: (...p) => q.run(...(p as never[])),
        };
      },
      transaction: (fn) => raw.transaction(fn)(),
    });
  }
  prepare(query: string): SqlStatement {
    return this.d1.prepare(query);
  }
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return this.d1.batch<T>(statements);
  }
}
