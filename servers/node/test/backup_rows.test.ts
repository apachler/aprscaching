// SPDX-License-Identifier: AGPL-3.0-or-later
// The database half of a portable backup (tools/backup/db.mjs): rows dumped as SQL restore into a new
// SQLite database identical to the original, a backup from an older schema migrates forward on restore, one
// from a schema this checkout does not know is refused, and the same rows replace a D1-shaped database.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/migrate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATIONS = path.join(ROOT, "db/migrations");
const TOOL = path.join(ROOT, "tools/backup/db.mjs");

function tool(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { input, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "acs-backup-"));
}

/** A migrated database with awkward values: quotes, newlines, Unicode, NULLs, a large integer and a blob. */
function seeded(dir: string, migrations = MIGRATIONS) {
  const file = path.join(dir, "src.db");
  const db = new Database(file);
  migrate(db, migrations);
  db.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, hint, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1)",
  ).run(
    "AC-1",
    "OE8APR",
    'It\'s a "test"\nwith a newline — and ümlauts',
    "traditional",
    47.07,
    15.42,
    null,
    1790000000,
  );
  db.prepare("INSERT INTO caches (code, owner_call, title, type, created_at, updated_at) VALUES (?,?,?,?,?,1)").run(
    "AC-2",
    "OE8APR",
    "second",
    "multi",
    9007199254740993n,
  );
  db.prepare("INSERT INTO rate_limits (key, count, reset_at) VALUES (?,?,?)").run("k", 1, 1);
  db.close();
  return file;
}

function snapshot(file: string) {
  const db = new Database(file, { readonly: true });
  db.defaultSafeIntegers(true);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
  )
    .map((t) => t.name)
    .filter((n) => !/^(_migrations|sqlite_)/.test(n));
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  db.close();
  return out;
}

const newest = () =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .at(-1)!;

describe("portable backup rows", () => {
  it("dump then restore gives the same rows", () => {
    const dir = tmp();
    try {
      const src = seeded(dir);
      const rows = tool(["dump", src]);
      expect(rows.status).toBe(0);
      expect(rows.out.startsWith(`-- aprscaching rows/1 schema=${newest()}`)).toBe(true);
      expect(rows.out).not.toMatch(/INSERT INTO "_migrations"/);
      const dst = path.join(dir, "dst.db");
      const r = tool(["restore", dst, MIGRATIONS, newest()], rows.out);
      expect(r.status, r.err).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ integrity: "ok", migratedForward: [], foreignKeyProblems: 0 });
      expect(snapshot(dst)).toEqual(snapshot(src));
      expect(tool(["schema", dst]).out.trim()).toBe(newest());
      // the restored database keeps counting ids after the restored ones
      const db = new Database(dst);
      const id = db
        .prepare(
          "INSERT INTO caches (code, owner_call, title, type, created_at, updated_at) VALUES ('AC-3','X','t','multi',1,1)",
        )
        .run();
      expect(Number(id.lastInsertRowid)).toBe(3);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a backup from an older schema migrates forward on restore", () => {
    const dir = tmp();
    try {
      const older = path.join(dir, "older-migrations");
      cpSync(MIGRATIONS, older, { recursive: true });
      rmSync(path.join(older, newest()));
      const src = seeded(dir, older);
      const rows = tool(["dump", src]);
      const oldSchema = readdirSync(older).sort().at(-1)!;
      expect(rows.out.startsWith(`-- aprscaching rows/1 schema=${oldSchema}`)).toBe(true);
      const dst = path.join(dir, "dst.db");
      const r = tool(["restore", dst, MIGRATIONS, oldSchema], rows.out);
      expect(r.status, r.err).toBe(0);
      expect(JSON.parse(r.out).migratedForward).toEqual([newest()]);
      expect(tool(["schema", dst]).out.trim()).toBe(newest());
      // the newest migration may add columns to caches: every value the older backup held arrives unchanged
      expect(snapshot(dst).caches).toMatchObject(snapshot(src).caches!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a backup from a schema this checkout does not know, and an existing target", () => {
    const dir = tmp();
    try {
      const rows = tool(["dump", seeded(dir)]).out;
      const r = tool(["restore", path.join(dir, "x.db"), MIGRATIONS, "9999_from_the_future.sql"], rows);
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/update the checkout/);
      const exists = tool(["restore", path.join(dir, "src.db"), MIGRATIONS, newest()], rows);
      expect(exists.status).not.toBe(0);
      expect(tool(["restore", path.join(dir, "y.db"), MIGRATIONS, newest()], "not a backup").status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same rows replace a D1-shaped database, and a D1 export reads back as rows", () => {
    const dir = tmp();
    try {
      const src = seeded(dir);
      const rows = tool(["dump", src]).out;
      const d1sql = tool(["to-d1"], rows).out;
      expect(d1sql.startsWith("PRAGMA defer_foreign_keys = true;")).toBe(true);
      // a D1 database: migrated, with rows of its own that the restore replaces
      const d1file = path.join(dir, "d1.db");
      const d1 = new Database(d1file);
      migrate(d1, MIGRATIONS);
      d1.prepare(
        "INSERT INTO caches (code, owner_call, title, type, created_at, updated_at) VALUES ('ZZ-9','X','old','multi',1,1)",
      ).run();
      // a table empty in the backup but full on the target is emptied too
      d1.prepare("INSERT INTO watches (callsign, cache_id) VALUES ('OE1X', 1)").run();
      d1.exec(d1sql);
      d1.close();
      expect(snapshot(d1file).caches).toEqual(snapshot(src).caches);
      expect(snapshot(d1file).watches).toEqual([]);
      // `wrangler d1 export --no-schema` output: its bookkeeping and transaction lines are dropped
      const exported = `PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "d1_migrations" ("id","name") VALUES(1,'0001_baseline.sql');\n${rows
        .split("\n")
        .slice(1)
        .join("\n")}`;
      const back = tool(["from-d1", newest()], exported).out;
      expect(back).not.toMatch(/d1_migrations|PRAGMA/);
      expect(JSON.parse(tool(["count"], back).out)).toEqual(JSON.parse(tool(["count"], rows).out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
