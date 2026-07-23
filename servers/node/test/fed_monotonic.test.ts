// SPDX-License-Identifier: AGPL-3.0-or-later
// Mirror upserts are version-monotonic — a replayed OLDER signed record must never roll
// a mirror back (e.g. to pre-redaction content). Runs the REAL upsert SQL against real SQLite via
// the same D1 shim the node-gateway serves with.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { upsertRemoteCache, upsertRemoteFind } from "@aprscaching/gateway/federation_sync";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "@aprscaching/gateway/env";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

function freshEnv() {
  const sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  return { env: { DB: makeD1(sqlite) } as unknown as Env, sqlite };
}
const rec = (title: string, updatedAt: number) => ({
  type: "cache",
  id: "peer.net:cache:1",
  cursor: updatedAt,
  data: { code: "PC-1", ownerCall: "OE8APR", title, type: "single", status: "active", updatedAt },
});

describe("version-monotonic mirror upserts", () => {
  it("a newer record overwrites; a replayed older record does NOT roll the mirror back", async () => {
    const { env } = freshEnv();
    await upsertRemoteCache(env, rec("original", 1000) as never, "peer.net");
    await upsertRemoteCache(env, rec("redacted", 2000) as never, "peer.net"); // owner redacts
    await upsertRemoteCache(env, rec("original", 1000) as never, "peer.net"); // hostile replay
    const row = await env.DB.prepare("SELECT title, updated_at FROM remote_caches WHERE global_id=?")
      .bind("peer.net:cache:1")
      .first<{ title: string; updated_at: number }>();
    expect(row?.title).toBe("redacted"); // the replay changed nothing
    expect(row?.updated_at).toBe(2000);
  });

  it("finds follow the same rule keyed on their ts", async () => {
    const { env } = freshEnv();
    const find = (comment: string, ts: number) => ({
      type: "find",
      id: "peer.net:find:9",
      cursor: ts,
      data: { cacheCode: "PC-1", loggerCall: "DL1ABC", logType: "found", ts, comment },
    });
    await upsertRemoteFind(env, find("with my phone number 123", 1000) as never, "peer.net");
    await upsertRemoteFind(env, find("(redacted)", 2000) as never, "peer.net");
    await upsertRemoteFind(env, find("with my phone number 123", 1000) as never, "peer.net"); // replay
    const row = await env.DB.prepare("SELECT comment FROM remote_finds WHERE global_id=?")
      .bind("peer.net:find:9")
      .first<{ comment: string }>();
    expect(row?.comment).toBe("(redacted)");
  });
});
