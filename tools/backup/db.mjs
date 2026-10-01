#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The database half of a portable backup (deploy/aprscaching backup / restore). A backup holds the rows as
 * SQL — INSERT statements with their column names, no schema — and the name of the newest migration the
 * database had. Restoring builds a fresh database at that migration, loads the rows and then applies every
 * newer migration, so a backup moves forward to the running code and never backward. Because the rows are
 * plain SQL, the same backup restores into SQLite (Self-host, bare metal, Pocket, Desktop) and into D1.
 *
 *   node tools/backup/db.mjs dump <db>                         rows of a SQLite database, to stdout
 *   node tools/backup/db.mjs schema <db>                       its newest applied migration
 *   node tools/backup/db.mjs restore <new-db> <migrations-dir> <schema> [--exact] < rows.sql
 *                                                              build a new SQLite database from rows;
 *                                                              --exact stops at the backup's schema (an
 *                                                              update's rollback, for the previous code)
 *   node tools/backup/db.mjs from-d1 < export.sql              rows of `wrangler d1 export --no-schema`
 *   node tools/backup/db.mjs to-d1 [tables] < rows.sql         SQL that replaces a D1 database's rows
 *                                                              (tables: the target's, comma-separated)
 *   node tools/backup/db.mjs count < rows.sql                  rows per table, as JSON
 *
 * Bookkeeping tables (the migration records of either runner, sqlite_*, D1's _cf_*) are never part of the
 * rows: each side keeps its own.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOOKKEEPING = /^(_migrations|d1_migrations|sqlite_.*|_cf_.*)$/;
const HEADER = "-- aprscaching rows/1";

function sqlite() {
  // better-sqlite3 comes with the Node server; resolve it from there
  const require = createRequire(join(root, "servers/node/package.json"));
  return require("better-sqlite3");
}

const stdin = () => readFileSync(0, "utf8");
const fail = (msg) => {
  process.stderr.write(`db.mjs: ${msg}\n`);
  process.exit(1);
};

/** A SQL literal for one value as better-sqlite3 returns it (safe integers on). */
function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (Buffer.isBuffer(v)) return `X'${v.toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const quoteId = (s) => `"${s.replace(/"/g, '""')}"`;

function schemaOf(db) {
  for (const table of ["_migrations", "d1_migrations"]) {
    try {
      const row = db.prepare(`SELECT name FROM ${table} ORDER BY name DESC LIMIT 1`).get();
      if (row?.name) return row.name;
    } catch {
      // the other runner's table
    }
  }
  return null;
}

/** The rows of every table, read in one transaction so the dump is consistent while the gateway writes. */
function dump(path) {
  const Database = sqlite();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  const out = [];
  const write = (s) => {
    out.push(s);
    if (out.length >= 512) process.stdout.write(out.splice(0).join(""));
  };
  db.transaction(() => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name)
      .filter((n) => !BOOKKEEPING.test(n));
    write(`${HEADER} schema=${schemaOf(db) ?? ""}\n-- tables=${tables.join(",")}\n`);
    for (const t of tables) {
      const cols = db
        .prepare(`PRAGMA table_info(${quoteId(t)})`)
        .all()
        .map((c) => c.name);
      const head = `INSERT INTO ${quoteId(t)} (${cols.map(quoteId).join(",")}) VALUES(`;
      const stmt = db.prepare(`SELECT ${cols.map(quoteId).join(",")} FROM ${quoteId(t)}`).raw(true);
      for (const row of stmt.iterate()) write(`${head}${row.map(literal).join(",")});\n`);
    }
  })();
  process.stdout.write(out.join(""));
  db.close();
}

function migrationsIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigration(db, dir, name) {
  const sql = readFileSync(join(dir, name), "utf8");
  db.transaction(() => {
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Math.floor(Date.now() / 1000));
  })();
}

/**
 * A new database from rows: the migrations up to the backup's, every table emptied of what they seed, the
 * rows (foreign keys checked once, at the end), then every newer migration. It refuses a backup from a newer schema than this checkout knows.
 */
function restore(path, dir, schema, exact) {
  if (existsSync(path)) fail(`${path} exists; restore builds a new database`);
  const files = migrationsIn(dir);
  if (!files.includes(schema))
    fail(`the backup's schema ${schema} is not among this checkout's migrations: update the checkout first`);
  const rows = stdin();
  if (!rows.startsWith(HEADER)) fail("stdin is not a rows backup");
  const Database = sqlite();
  const db = new Database(path);
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const before = files.filter((f) => f <= schema);
  const after = exact ? [] : files.filter((f) => f > schema);
  for (const f of before) applyMigration(db, dir, f);
  db.pragma("foreign_keys = OFF");
  // the backup is the whole truth at its schema: rows the migrations seed are replaced, not doubled
  const seeded = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name)
    .filter((n) => !BOOKKEEPING.test(n));
  db.transaction(() => {
    for (const t of seeded) db.exec(`DELETE FROM ${quoteId(t)}`);
    db.exec(rows);
  })();
  db.pragma("foreign_keys = ON");
  const broken = db.pragma("foreign_key_check");
  for (const f of after) applyMigration(db, dir, f);
  const ok = db.pragma("integrity_check", { simple: true });
  db.close();
  process.stdout.write(
    `${JSON.stringify({ schema, migratedForward: after, integrity: ok, foreignKeyProblems: broken.length })}\n`,
  );
  if (ok !== "ok") fail(`integrity check: ${ok}`);
}

/** The rows of a D1 export, without D1's and the migrations' bookkeeping and without transaction lines. */
function fromD1() {
  const lines = stdin().split("\n");
  const keep = lines.filter((l) => {
    const m = /^INSERT INTO "?([A-Za-z0-9_]+)"?/.exec(l);
    if (m) return !BOOKKEEPING.test(m[1]);
    return !/^(PRAGMA|BEGIN|COMMIT|CREATE|DELETE)\b/i.test(l.trim()) && !/^--/.test(l.trim());
  });
  const schema = process.argv[3] ?? "";
  process.stdout.write(`${HEADER} schema=${schema}\n${keep.join("\n").trim()}\n`);
}

/**
 * Rows as SQL that replaces a D1 database's contents: every table emptied — those the backup lists, those it
 * has rows for and those named in `extra` (the target's own tables) — then filled.
 */
function toD1(extra) {
  const rows = stdin();
  if (!rows.startsWith(HEADER)) fail("stdin is not a rows backup");
  const listed = /^-- tables=(.*)$/m.exec(rows)?.[1]?.split(",") ?? [];
  const tables = [
    ...new Set([
      ...listed,
      ...(extra ?? "").split(","),
      ...[...rows.matchAll(/^INSERT INTO "([^"]+)"/gm)].map((m) => m[1]),
    ]),
  ].filter((t) => t && !BOOKKEEPING.test(t));
  process.stdout.write("PRAGMA defer_foreign_keys = true;\n");
  for (const t of tables) process.stdout.write(`DELETE FROM ${quoteId(t)};\n`);
  process.stdout.write(rows.replace(/^--.*\n/gm, ""));
}

function count() {
  const rows = stdin();
  const counts = {};
  for (const m of rows.matchAll(/^INSERT INTO "([^"]+)"/gm)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  const schema = /^-- aprscaching rows\/1 schema=(\S*)/.exec(rows)?.[1] ?? null;
  process.stdout.write(`${JSON.stringify({ schema, tables: counts })}\n`);
}

const [cmd, a, b, c, d] = process.argv.slice(2);
switch (cmd) {
  case "dump":
    if (!a) fail("dump <db>");
    dump(a);
    break;
  case "schema": {
    if (!a) fail("schema <db>");
    const Database = sqlite();
    const db = new Database(a, { readonly: true, fileMustExist: true });
    process.stdout.write(`${schemaOf(db) ?? ""}\n`);
    db.close();
    break;
  }
  case "restore":
    if (!a || !b || !c) fail("restore <new-db> <migrations-dir> <schema> < rows.sql");
    restore(a, b, c, d === "--exact");
    break;
  case "from-d1":
    fromD1();
    break;
  case "to-d1":
    toD1(a);
    break;
  case "count":
    count();
    break;
  default:
    fail("commands: dump, schema, restore, from-d1, to-d1, count");
}
