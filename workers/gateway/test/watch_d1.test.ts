// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Watch alerts on a real D1 engine. D1 caps a statement at 100 bound parameters, a limit SQLite on
 * Node and Bun does not share, so a busy ingest batch that hears more than 100 distinct stations must
 * still find the watched one among them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { recordWatchHeard } from "../src/watch.js";
import type { Env } from "../src/env.js";
import type { SqlDatabase } from "../src/runtime.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: SqlDatabase }>>>;
let env: Env;
let tmp: string;

beforeAll(async () => {
  process.env.WRANGLER_SEND_METRICS = "false";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watch-d1-"));
  const config = path.join(tmp, "wrangler.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      name: "watch-d1",
      compatibility_date: "2026-04-07",
      d1_databases: [{ binding: "DB", database_name: "watch-d1", database_id: "watch-d1" }],
    }),
  );
  proxy = await getPlatformProxy<{ DB: SqlDatabase }>({ configPath: config, persist: false });
  const db = proxy.env.DB;
  for (const f of fs
    .readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    await db.batch(unstable_splitSqlQuery(sql).map((q) => db.prepare(q)));
  }
  env = { DB: db } as unknown as Env;
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("watch alerts on D1", () => {
  it("alerts a watcher when the watched call is one of more than 100 stations in a batch", async () => {
    await env.DB.prepare("INSERT INTO watch_calls (account_id, callsign, added_at) VALUES (?,?,?)")
      .bind("acct-1", "OE8WAT", 1)
      .run();
    const heard = Array.from({ length: 150 }, (_, i) => ({ src: `OE${i}XX`, lat: 47, lon: 15 }));
    heard.push({ src: "OE8WAT-9", lat: 47.07, lon: 15.42 });
    await recordWatchHeard(env, heard);
    const alerts = await env.DB.prepare("SELECT callsign, kind FROM watch_alerts WHERE account_id = ?")
      .bind("acct-1")
      .all<{ callsign: string; kind: string }>();
    expect(alerts.results.map((a) => a.callsign)).toEqual(["OE8WAT"]);
  });
});
