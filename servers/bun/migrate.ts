// SPDX-License-Identifier: AGPL-3.0-or-later
/** Apply db/migrations/*.sql in order under bun:sqlite (Bun analogue of servers/node/migrate.ts). */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function migrate(db: Database, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(f, Math.floor(Date.now() / 1000));
    })();
    ran.push(f);
  }
  return ran;
}
