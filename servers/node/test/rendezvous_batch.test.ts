// SPDX-License-Identifier: AGPL-3.0-or-later
// Living-cache rendezvous runs inline on every ingest batch, so it reads the opted-in living caches once per
// batch through their partial index, and joins stations on its primary key.
import { describe, it, expect } from "vitest";
import { recordRendezvous } from "@aprscaching/gateway/rendezvous";
import type { Env } from "@aprscaching/gateway/env";
import { instanceEnv } from "./helpers/fedpeer.js";

const now = () => Math.floor(Date.now() / 1000);

async function living(env: Env, code: string, call: string, lat: number, lon: number) {
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, status, station_call, rendezvous, created_at, updated_at)
     VALUES (?, 'OE8OWN', ?, 'aprs_living', ?, ?, 'active', ?, 1, 1, 1)`,
  )
    .bind(code, code, lat, lon, call)
    .run();
  await env.DB.prepare("INSERT INTO stations (callsign, lat, lon, last_seen) VALUES (?, ?, ?, ?)")
    .bind(call.toUpperCase(), lat, lon, now())
    .run();
  return Number(r.meta.last_row_id);
}

/** The env with every statement's SQL recorded. */
function recording(env: Env) {
  const seen: string[] = [];
  const DB = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          seen.push(sql);
          return t.prepare(sql);
        };
      const v = (t as unknown as Record<PropertyKey, unknown>)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { env: { ...env, DB } as Env, seen };
}

const meetings = async (env: Env) =>
  (await env.DB.prepare("SELECT cache_a, cache_b FROM rendezvous_log").all<{ cache_a: number; cache_b: number }>())
    .results;

describe("living-cache rendezvous on an ingest batch", () => {
  it("records one meeting of two co-located living caches, and none again within the hour", async () => {
    const env = instanceEnv("rdv.example", null);
    const a = await living(env, "AC-LA", "OE8AAA-9", 47.07, 15.42);
    const b = await living(env, "AC-LB", "oe8bbb-9", 47.0705, 15.4205);
    await recordRendezvous(env, [{ src: "OE8AAA-9", lat: 47.07, lon: 15.42 }]);
    expect(await meetings(env)).toEqual([{ cache_a: a, cache_b: b }]);
    await recordRendezvous(env, [{ src: "OE8AAA-9", lat: 47.07, lon: 15.42 }]);
    expect(await meetings(env)).toHaveLength(1);
    await recordRendezvous(env, [{ src: "OE1XYZ", lat: 47.07, lon: 15.42 }]);
    expect(await meetings(env)).toHaveLength(1);
  });

  it("reads the caches once per batch however many positions it holds", async () => {
    const base = instanceEnv("rdv.example", null);
    await living(base, "AC-LA", "OE8AAA-9", 47.07, 15.42);
    const { env, seen } = recording(base);
    const heard = Array.from({ length: 50 }, (_, i) => ({ src: `OE1X${i}`, lat: 47, lon: 15 }));
    await recordRendezvous(env, heard);
    expect(seen.filter((s) => /\bFROM caches\b/.test(s))).toHaveLength(1);
  });

  it("finds the living caches through their index and stations through its primary key", async () => {
    const base = instanceEnv("rdv.example", null);
    await living(base, "AC-LA", "OE8AAA-9", 47.07, 15.42);
    const { env, seen } = recording(base);
    await recordRendezvous(env, [{ src: "OE8AAA-9", lat: 47.07, lon: 15.42 }]);
    const sql = seen.find((s) => /\bFROM caches\b/.test(s))!;
    const binds = (sql.match(/\?/g) ?? []).map(() => 0);
    const plan = (
      await base.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>()
    ).results.map((r) => r.detail);
    expect(plan.join("\n")).toContain("idx_caches_living");
    expect(plan.some((d) => /^SCAN (s|stations)\b/.test(d))).toBe(false);
  });
});
