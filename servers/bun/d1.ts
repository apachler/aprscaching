// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D1-compatible adapter over Bun's built-in `bun:sqlite` — the Bun-runtime analogue of
 * `servers/node/src/d1.ts` (which wraps better-sqlite3). Presents the exact `SqlDatabase` surface the
 * gateway handlers use (prepare → bind → run/first/all + batch), so the *same* business logic runs
 * unchanged on Cloudflare D1, Node+SQLite, and Bun+bun:sqlite.
 *
 * bun:sqlite is synchronous; results are wrapped in resolved Promises to match D1's async API.
 */
import { Database } from "bun:sqlite";
import type { SqlDatabase, SqlStatement, SqlResult } from "@aprsweb/gateway/runtime";

/** D1 accepts null/number/string/blob. SR-RT-08: real D1 throws `D1_TYPE_ERROR` on an `undefined`
 *  bind — throw the same instead of coercing to null, so a parity bug fails on Bun too, not only on
 *  Workers. Booleans stay coerced to 0/1 for convenience. */
function norm(values: unknown[]): unknown[] {
  return values.map((v) => {
    if (v === undefined) throw new Error("D1_TYPE_ERROR: undefined bind value (use null) — Cloudflare D1 parity");
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
}

/** A `… RETURNING` writer reads back rows yet still needs real changes()/last_insert_rowid() meta. */
const isDml = (sql: string): boolean => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

class Stmt implements SqlStatement {
  constructor(
    private db: Database,
    private sql: string,
    private params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new Stmt(this.db, this.sql, norm(values));
  }

  /** Synchronous execution (used directly inside batch transactions). */
  execSync(): SqlResult {
    const q = this.db.query(this.sql);
    // a row-returning statement (SELECT / PRAGMA table_info / … / INSERT … RETURNING) has columns.
    if (q.columnNames.length > 0) {
      const results = q.all(...(this.params as never[])) as unknown[];
      // SR-RT-09: SELECT → zeroed meta (as D1); a `… RETURNING` writer carries real rows-affected/rowid.
      if (!isDml(this.sql)) return { results, meta: { last_row_id: 0, changes: 0 } };
      const m = this.db.query("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
      return { results, meta: { last_row_id: Number(m.r), changes: Number(m.c) } };
    }
    const info = q.run(...(this.params as never[]));
    return { results: [], meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
  }

  async run<T = unknown>(): Promise<SqlResult<T>> {
    return this.execSync() as SqlResult<T>;
  }
  async all<T = unknown>(): Promise<SqlResult<T>> {
    return this.execSync() as SqlResult<T>;
  }
  async first<T = unknown>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...(this.params as never[])) as T | undefined) ?? null;
  }
}

/** SqlDatabase backed by bun:sqlite. Accepts a path (opens it) or an existing Database. */
export class BunDb implements SqlDatabase {
  readonly raw: Database;
  constructor(pathOrDb: string | Database) {
    this.raw = typeof pathOrDb === "string" ? new Database(pathOrDb, { create: true }) : pathOrDb;
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
  }
  prepare(query: string): SqlStatement {
    return new Stmt(this.raw, query);
  }
  async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    const txn = this.raw.transaction((stmts: Stmt[]) => stmts.map((s) => s.execSync()));
    return txn(statements as Stmt[]) as SqlResult<T>[];
  }
}
