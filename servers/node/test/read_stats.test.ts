// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/v1/stats counts what the landing page shows: active native caches, Tier A finds of the last seven
// days, stations heard in the last hour; nothing older, nothing unverified, nothing estimated.
import { describe, it, expect } from "vitest";
import { addCache, instanceEnv, serve } from "./helpers/fedpeer.js";

const now = () => Math.floor(Date.now() / 1000);

describe("GET /api/v1/stats", () => {
  it("counts active native caches, this week's finds heard on the air, and stations of the last hour", async () => {
    const env = instanceEnv("stats.example", null);
    const fetch = serve(env);
    const a = await addCache(env);
    await addCache(env);
    const archived = await addCache(env);
    await env.DB.prepare("UPDATE caches SET status = 'archived' WHERE id = ?").bind(archived).run();
    await env.DB.prepare(
      `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at, source)
       VALUES ('SOTA-1', 'SOTA', 'A summit', 'sota', 47.1, 15.4, 1, 1, 'sota')`,
    ).run();
    let logger = 0; // a cache takes one log per callsign
    const log = (tier: string, verified: number, ago: number, type = "found") =>
      env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(a, `OE8L${++logger}`, now() - ago, type, verified, tier)
        .run();
    await log("A", 1, 3600);
    await log("A", 1, 6 * 86400);
    await log("A", 1, 8 * 86400); // older than a week
    await log("B", 1, 3600); // located by the app, not heard on the air
    await log("A", 0, 3600); // not verified
    await log("A", 1, 3600, "dnf");
    const station = (call: string, ago: number) =>
      env.DB.prepare("INSERT INTO stations (callsign, lat, lon, last_seen) VALUES (?, 47, 15, ?)")
        .bind(call, now() - ago)
        .run();
    await station("OE6XGR-10", 60);
    await station("OE6GHJ-7", 1800);
    await station("OE5OLD", 7200); // heard two hours ago

    const res = await fetch(new Request("https://stats.example/api/v1/stats"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await res.json()) as Record<string, number>;
    expect(body).toMatchObject({ caches: 2, findsOnAirThisWeek: 2, stationsHeardLastHour: 2 });
    expect(Math.abs(body.at! - now())).toBeLessThan(5);
  });

  it("is listed in the API index", async () => {
    const res = await serve(instanceEnv("stats.example", null))(new Request("https://stats.example/api/v1"));
    const d = (await res.json()) as { endpoints: { path: string }[] };
    expect(d.endpoints.map((e) => e.path)).toContain("/api/v1/stats");
  });
});
