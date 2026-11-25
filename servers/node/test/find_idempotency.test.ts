// SPDX-License-Identifier: AGPL-3.0-or-later
// The partial unique index idx_cache_logs_found_unique makes a find idempotent per cache and base call —
// a racing or replayed found POST, or two racing logs under two SSIDs of one call, can't double-insert (and
// thus can't double-count). Runs against real SQLite so it exercises the actual index.
import { describe, it, expect, afterEach, vi } from "vitest";
import { authEnv, call, emailSignup, markCallVerified } from "./helpers/authflow.js";
import { newFedKey, stubFetch } from "./helpers/fedpeer.js";
import Database from "better-sqlite3";
import { migrate } from "../src/migrate.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

function freshDb() {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

const insertFound = (db: Database.Database, cacheId: number, logger: string) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method) VALUES (?,?,?, 'found', 1, 'B', 'app_geo')",
    )
    .run(cacheId, logger, 1000).changes;

describe("find-log idempotency", () => {
  it("a second found for the same (cache, logger) is ignored", () => {
    const db = freshDb();
    expect(insertFound(db, 1, "DL1ABC")).toBe(1); // first lands
    expect(insertFound(db, 1, "DL1ABC")).toBe(0); // replay ignored (unique index)
    const n = db.prepare("SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id=1 AND logger_call='DL1ABC'").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  it("a found under another SSID of the same call is ignored", () => {
    const db = freshDb();
    expect(insertFound(db, 1, "DL1ABC-7")).toBe(1);
    expect(insertFound(db, 1, "DL1ABC-9")).toBe(0);
    expect(insertFound(db, 1, "DL1ABC")).toBe(0);
    expect(insertFound(db, 1, "DL1ABCD")).toBe(1); // another call that merely starts alike
  });

  it("different loggers and different caches are independent", () => {
    const db = freshDb();
    expect(insertFound(db, 1, "DL1ABC")).toBe(1);
    expect(insertFound(db, 1, "OE3XYZ")).toBe(1); // different logger, same cache → allowed
    expect(insertFound(db, 2, "DL1ABC")).toBe(1); // same logger, different cache → allowed
  });

  it("the index only constrains found — dnf/note can repeat", () => {
    const db = freshDb();
    const dnf = () =>
      db
        .prepare(
          "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (1,'DL1ABC',1000,'dnf',0)",
        )
        .run().changes;
    expect(dnf()).toBe(1);
    expect(dnf()).toBe(1); // a second DNF is fine (partial index is WHERE log_type='found')
  });
});

describe("one person logging one cache under two SSIDs at once", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores one find, though both logs pass the already-found check before either commits", async () => {
    // both logs wait on a peer that answers only once both have asked it: each has passed the
    // already-found check by then, and neither has committed
    const key = await newFedKey();
    const env = authEnv({ INSTANCE: "hub.example", FED_PRIVATE_KEY: key.env, FED_CORROBORATION_QUORUM: "1" });
    await env.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES ('https://p1.example', 'p1.example', ?, ?, 'trusted', 'manual')",
    )
      .bind(key.pub, JSON.stringify([{ x: key.pub }]))
      .run();
    const r = await env.DB.prepare(
      "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES ('AC-SS', 'OE8OWN', 'Twice', 'traditional', 47.07, 15.43, 1, 1)",
    ).run();
    const s = await emailSignup(env, "twice@example.test", "OE8LOG");
    await markCallVerified(env, "OE8LOG");
    let asked = 0;
    let release!: () => void;
    const both = new Promise<void>((res) => (release = res));
    stubFetch({
      "https://p1.example": async () => {
        if (++asked >= 2) release();
        await both;
        return new Response("busy", { status: 503 });
      },
    });
    const log = (ssid: string) =>
      call(
        env,
        "POST",
        `/api/caches/${r.meta.last_row_id}/logs`,
        { logType: "found", loggerCall: ssid },
        { cookie: s.cookie },
      );
    const res = await Promise.all([log("OE8LOG-7"), log("OE8LOG-9")]);
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(res.map((x) => x.status)).toEqual([200, 200]);
    expect(res.filter((x) => x.data.duplicate === true)).toHaveLength(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id = ? AND log_type = 'found'")
      .bind(r.meta.last_row_id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
