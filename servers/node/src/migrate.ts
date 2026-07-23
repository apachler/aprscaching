// SPDX-License-Identifier: AGPL-3.0-or-later
/** Apply db/migrations/*.sql in order (the Node analogue of `wrangler d1 migrations apply`). */
import fs from "node:fs";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";

export function migrate(db: BetterSqlite3.Database, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const insert = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  const ran: string[] = [];

  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      insert.run(f, Math.floor(Date.now() / 1000));
      db.exec("COMMIT");
      ran.push(f);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`, { cause: e });
    }
  }
  return ran;
}
