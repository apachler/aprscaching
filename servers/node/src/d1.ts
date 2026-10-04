// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The gateway's database adapter over a synchronous SQLite driver — better-sqlite3 here (makeD1),
 * bun:sqlite in servers/bun (which reuses d1Over). Presents the async `SqlDatabase` surface the gateway
 * handlers use (prepare → bind → run/first/all, plus batch; the D1 statement shape), so the *exact same*
 * business logic runs on both drivers.
 *
 * SQLite drivers are synchronous; results are wrapped in resolved Promises to match the async API.
 */
import type BetterSqlite3 from "better-sqlite3";
import type { SqlDatabase, SqlStatement, SqlResult } from "@aprscaching/gateway/runtime";

/** One prepared statement, as a synchronous driver exposes it. */
export interface SqliteStatement {
  /** Does it return rows (a SELECT, a PRAGMA, a `… RETURNING` writer)? */
  readonly reader: boolean;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

/** The synchronous SQLite driver the adapter runs on. */
export interface SqliteDriver {
  prepare(sql: string): SqliteStatement;
  /** Run `fn` in one transaction, committing on return and rolling back on a throw. */
  transaction<T>(fn: () => T): T;
}

/** Binds accept null/number/string; booleans become 0/1. An `undefined` bind is a caller bug (a
 *  missing field), so it throws rather than being stored as null — the bug surfaces in a test, not as a
 *  silently empty column. */
function norm(values: unknown[]): unknown[] {
  return values.map((v) => {
    if (v === undefined) throw new Error("undefined bind value (use null)");
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
}

/** A DML statement (the only kind that reports rows-affected). A `… RETURNING` is DML but reads back
 *  rows, so it lands in the reader branch yet still needs real `changes()`/`last_insert_rowid()` meta. */
const isDml = (sql: string): boolean => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

class Stmt implements SqlStatement {
  constructor(
    private db: SqliteDriver,
    private sql: string,
    private params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new Stmt(this.db, this.sql, norm(values));
  }

  /** Synchronous execution (used directly inside batch transactions). */
  execSync(): SqlResult {
    const s = this.db.prepare(this.sql);
    if (s.reader) {
      const results = s.all(...this.params) as unknown[];
      // A plain SELECT reports zeroed meta; a `… RETURNING` writer must carry real rows-affected /
      // last rowid so handlers that read `meta.changes` see what the statement changed.
      if (!isDml(this.sql)) return { results, meta: { last_row_id: 0, changes: 0 } };
      const m = this.db.prepare("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
      return { results, meta: { last_row_id: Number(m.r), changes: Number(m.c) } };
    }
    const info = s.run(...this.params);
    return { results: [], meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
  }

  async run<T = unknown>(): Promise<SqlResult<T>> {
    return this.execSync() as SqlResult<T>;
  }
  async all<T = unknown>(): Promise<SqlResult<T>> {
    return this.execSync() as SqlResult<T>;
  }
  async first<T = unknown>(): Promise<T | null> {
    const s = this.db.prepare(this.sql);
    return (s.get(...this.params) as T | undefined) ?? null;
  }
}

/** The gateway's database over any synchronous SQLite driver. */
export function d1Over(db: SqliteDriver): SqlDatabase {
  return {
    prepare(query: string): SqlStatement {
      return new Stmt(db, query);
    },
    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      return db.transaction(() => (statements as Stmt[]).map((s) => s.execSync())) as SqlResult<T>[];
    },
  };
}

/** The gateway's database over better-sqlite3. */
export function makeD1(db: BetterSqlite3.Database): SqlDatabase {
  return d1Over({
    prepare: (sql) => db.prepare(sql) as SqliteStatement,
    transaction: (fn) => db.transaction(fn)(),
  });
}
