// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The self-host migration runner (the Node, Bun and desktop analogue of `wrangler d1 migrations
 * apply`). Each migration not yet recorded in `_migrations` runs in its own transaction, in name order,
 * and is recorded in the same transaction, so a failed migration leaves nothing half-applied.
 * Runtime-neutral: the caller supplies the migrations (read from `db/migrations`, or embedded in the
 * desktop binary) and a two-method view of its SQLite driver.
 */
import { nowS } from "./util/time.js";

export interface Migration {
  name: string;
  sql: string;
}

/** What the runner needs from a synchronous SQLite driver. */
export interface MigrationTarget {
  /** Run one or more statements. */
  exec(sql: string): void;
  /** Run one parameterised statement and return its rows (none for a write). */
  query(sql: string, ...params: (string | number)[]): unknown[];
}

/** Apply the pending migrations; returns the names applied, in order. */
export function migrate(db: MigrationTarget, migrations: Migration[]): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.query("SELECT name FROM _migrations") as { name: string }[]).map((r) => r.name));
  const ran: string[] = [];
  for (const m of [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (applied.has(m.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", m.name, nowS());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`, { cause: e });
    }
    ran.push(m.name);
  }
  return ran;
}
