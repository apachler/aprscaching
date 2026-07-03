// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { upsertImported } from "@aprsweb/gateway/import";
import type { Env } from "@aprsweb/gateway/env";

const MIGRATIONS = path.resolve(fileURLToPath(import.meta.url), "../../../../db/migrations");

function freshEnv(): { env: Env; db: Database.Database } {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  return { env: { DB: makeD1(db) } as unknown as Env, db };
}

const rec = (over: Partial<Parameters<typeof upsertImported>[1][number]>) => ({
  source: "sota",
  externalId: "X",
  code: "X",
  type: "sota" as const,
  title: "T",
  lat: 47.07,
  lon: 15.42,
  sourceName: "SOTA",
  sourceUrl: "https://sotl.as/summits/X",
  ...over,
});

describe("import upsert (M3)", () => {
  let env: Env, db: Database.Database;
  beforeEach(() => {
    ({ env, db } = freshEnv());
  });

  it("inserts new imported caches with attribution, then UPDATES on re-import (no duplicate)", async () => {
    const a = await upsertImported(env, [
      rec({
        source: "pota",
        externalId: "US-0001",
        code: "US-0001",
        type: "pota",
        title: "Acadia",
        sourceName: "POTA",
      }),
    ]);
    expect(a).toMatchObject({ imported: 1, updated: 0 });

    const b = await upsertImported(env, [
      rec({
        source: "pota",
        externalId: "US-0001",
        code: "US-0001",
        type: "pota",
        title: "Acadia National Park",
        sourceName: "POTA",
      }),
    ]);
    expect(b).toMatchObject({ imported: 0, updated: 1 });

    const rows = db
      .prepare("SELECT title, source, source_name, source_url FROM caches WHERE source='pota'")
      .all() as any[];
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].title).toBe("Acadia National Park"); // updated in place
    expect(rows[0].source_name).toBe("POTA");
  });

  it("de-duplicates across sources with ham-radio priority", async () => {
    // a ham summit (SOTA, priority 1) at a point
    await upsertImported(env, [
      rec({ source: "sota", externalId: "GM/SI-001", code: "GM/SI-001", lat: 47.0, lon: 15.0 }),
    ]);
    // an OSM peak (priority 3) ~20 m away -> should be SKIPPED (deduped, ham wins)
    const osm = await upsertImported(env, [
      rec({
        source: "osm",
        externalId: "node/9",
        code: "OSM-9",
        type: "traditional",
        title: "Peak",
        sourceName: "OpenStreetMap",
        lat: 47.00018,
        lon: 15.0,
      }),
    ]);
    expect(osm.deduped).toBe(1);
    expect(osm.imported).toBe(0);

    const cnt = (db.prepare("SELECT COUNT(*) n FROM caches WHERE status='active'").get() as any).n;
    expect(cnt).toBe(1); // only the SOTA summit survives
  });

  it("a higher-priority import supersedes a weaker nearby one already present", async () => {
    // an OSM peak imported first
    await upsertImported(env, [
      rec({
        source: "osm",
        externalId: "node/9",
        code: "OSM-9",
        type: "traditional",
        title: "Peak",
        sourceName: "OpenStreetMap",
        lat: 47.0,
        lon: 15.0,
      }),
    ]);
    // then the SOTA summit at ~same spot -> inserted, OSM one archived
    const sota = await upsertImported(env, [
      rec({ source: "sota", externalId: "GM/SI-001", code: "GM/SI-001", lat: 47.0001, lon: 15.0 }),
    ]);
    expect(sota.imported).toBe(1);
    expect(sota.superseded).toBe(1);

    const active = db.prepare("SELECT source FROM caches WHERE status='active'").all() as any[];
    expect(active).toHaveLength(1);
    expect(active[0].source).toBe("sota");
    const archived = (db.prepare("SELECT COUNT(*) n FROM caches WHERE status='archived'").get() as any).n;
    expect(archived).toBe(1);
  });

  it("does not dedupe distinct ham programs at the same spot (equal priority co-exist)", async () => {
    await upsertImported(env, [rec({ source: "sota", externalId: "S1", code: "S1", lat: 47.0, lon: 15.0 })]);
    const wwff = await upsertImported(env, [
      rec({
        source: "wwff",
        externalId: "W1",
        code: "W1",
        type: "wwff",
        title: "Reserve",
        sourceName: "WWFF",
        lat: 47.0,
        lon: 15.0,
      }),
    ]);
    expect(wwff.imported).toBe(1);
    expect(wwff.deduped).toBe(0);
  });
});
