// SPDX-License-Identifier: AGPL-3.0-or-later
/** Apply db/migrations/*.sql to a better-sqlite3 database with the shared runner. */
import fs from "node:fs";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { migrate as runMigrations, type Migration } from "@aprscaching/gateway/migrate";

/** The `*.sql` files of a migrations directory (Node and Bun both read it with node:fs). */
export function migrationsFromDir(dir: string): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

export function migrate(db: BetterSqlite3.Database, dir: string): string[] {
  return runMigrations(
    {
      exec: (sql) => void db.exec(sql),
      query: (sql, ...params) => {
        const st = db.prepare(sql);
        if (st.reader) return st.all(...params);
        st.run(...params);
        return [];
      },
    },
    migrationsFromDir(dir),
  );
}
