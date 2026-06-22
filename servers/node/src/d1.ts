/**
 * A D1-compatible adapter over better-sqlite3. Presents the same `SqlDatabase` surface the
 * gateway handlers use (prepare → bind → run/first/all, plus batch), so the *exact same*
 * business logic runs unchanged on Cloudflare D1 and on local SQLite.
 *
 * better-sqlite3 is synchronous; we wrap results in resolved Promises to match D1's async API.
 */
import type BetterSqlite3 from "better-sqlite3";
import type { SqlDatabase, SqlStatement, SqlResult } from "@aprsweb/gateway/runtime";

type DB = BetterSqlite3.Database;

/** D1 accepts null/number/string; better-sqlite3 rejects `undefined` and booleans. */
function norm(values: unknown[]): unknown[] {
  return values.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
}

class Stmt implements SqlStatement {
  constructor(private db: DB, private sql: string, private params: unknown[] = []) {}

  bind(...values: unknown[]): SqlStatement {
    return new Stmt(this.db, this.sql, norm(values));
  }

  /** Synchronous execution (used directly inside batch transactions). */
  execSync(): SqlResult {
    const s = this.db.prepare(this.sql);
    if (s.reader) {
      return { results: s.all(...this.params) as unknown[], meta: { last_row_id: 0, changes: 0 } };
    }
    const info = s.run(...this.params);
    return { results: [], meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
  }

  async run<T = unknown>(): Promise<SqlResult<T>> { return this.execSync() as SqlResult<T>; }
  async all<T = unknown>(): Promise<SqlResult<T>> { return this.execSync() as SqlResult<T>; }
  async first<T = unknown>(): Promise<T | null> {
    const s = this.db.prepare(this.sql);
    return ((s.get(...this.params) as T | undefined) ?? null);
  }
}

export function makeD1(db: DB): SqlDatabase {
  return {
    prepare(query: string): SqlStatement {
      return new Stmt(db, query);
    },
    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      const txn = db.transaction((stmts: Stmt[]) => stmts.map((s) => s.execSync()));
      return txn(statements as Stmt[]) as SqlResult<T>[];
    },
  };
}
