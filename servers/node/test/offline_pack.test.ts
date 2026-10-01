// SPDX-License-Identifier: AGPL-3.0-or-later
// The offline pack: the caches of a box, a circle or a route corridor with what the cache page needs
// offline, never a stage's secrets; capped, refused when too large, and cheap to refresh when unchanged.
import { describe, it, expect } from "vitest";
import { encodePolyline, PACK_LOGS_PER_CACHE, type PackResponse } from "@aprscaching/shared";
import { instanceEnv, serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

let ip = 0;
function setup() {
  return instanceEnv("pack.example", null) as unknown as Env;
}
async function cache(env: Env, code: string, lat: number, lon: number, extra: Record<string, unknown> = {}) {
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, hint, description, status, created_at, updated_at)
     VALUES (?, 'OE8OWN', ?, ?, ?, ?, 'under the stone', 'a fine view', ?, 100, 100)`,
  )
    .bind(code, `Cache ${code}`, extra.type ?? "traditional", lat, lon, extra.status ?? "active")
    .run();
  return Number(r.meta.last_row_id);
}
const get = async (env: Env, query: string, headers: Record<string, string> = {}) => {
  const res = await serve(env)(
    new Request(`https://pack.example/api/offline/pack?${query}`, {
      headers: { "cf-connecting-ip": `10.0.0.${++ip % 250}`, ...headers },
    }),
  );
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    body: res.status === 200 ? ((await res.json()) as PackResponse) : await res.json().catch(() => null),
  };
};
const codes = (b: PackResponse) => b.caches.map((c) => c.code).sort();

describe("the area", () => {
  it("a box takes the caches inside it, never archived ones", async () => {
    const env = setup();
    await cache(env, "AC-IN", 47.1, 15.1);
    await cache(env, "AC-OUT", 48.5, 15.1);
    await cache(env, "AC-GONE", 47.2, 15.2, { status: "archived" });
    const r = await get(env, "bbox=15,47,15.5,47.5");
    expect(r.status).toBe(200);
    expect(codes(r.body as PackResponse)).toEqual(["AC-IN"]);
  });

  it("a circle cuts the corners of its box", async () => {
    const env = setup();
    await cache(env, "AC-NEAR", 47.0, 15.0);
    await cache(env, "AC-CORNER", 47.08, 15.12); // inside the 10 km box, ~13 km away
    const r = await get(env, "lat=47&lon=15&r=10000");
    expect(codes(r.body as PackResponse)).toEqual(["AC-NEAR"]);
  });

  it("a route takes the caches along its corridor", async () => {
    const env = setup();
    await cache(env, "AC-ON", 47.0005, 15.05); // ~55 m off the line
    await cache(env, "AC-OFF", 47.05, 15.05); // ~5.5 km off
    const route = encodePolyline([
      [47, 15],
      [47, 15.1],
    ]);
    const r = await get(env, `route=${encodeURIComponent(route)}&corridor=500`);
    expect(codes(r.body as PackResponse)).toEqual(["AC-ON"]);
  });

  it("filters by type", async () => {
    const env = setup();
    await cache(env, "AC-T", 47.1, 15.1);
    await cache(env, "AC-M", 47.1, 15.2, { type: "multi" });
    expect(codes((await get(env, "bbox=15,47,15.5,47.5&types=multi")).body as PackResponse)).toEqual(["AC-M"]);
  });

  it("refuses an area too large, or none at all", async () => {
    const env = setup();
    expect((await get(env, "bbox=10,40,15,45")).status).toBe(400);
    expect((await get(env, "lat=47&lon=15&r=500000")).status).toBe(400);
    expect((await get(env, "")).status).toBe(400);
    expect((await get(env, "route=!!!")).status).toBe(400); // outside the polyline alphabet
  });
});

describe("what a cache carries", () => {
  it("the page details, the latest logs and the images, never a stage's secrets", async () => {
    const env = setup();
    const id = await cache(env, "AC-FULL", 47.1, 15.1);
    for (let i = 0; i < PACK_LOGS_PER_CACHE + 3; i++)
      await env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, ?, ?, 'note', 0)",
      )
        .bind(id, `OE8L${i}`, 1000 + i)
        .run();
    await env.DB.prepare(
      "INSERT INTO cache_stages (cache_id, stage_no, lat, lon, clue, unlock, unlock_secret) VALUES (?, 1, 47.2, 15.2, 'the oak', 'nfc', 'TAG-SECRET')",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO cache_media (cache_id, media_key, kind, content_type, title, bytes, created_at) VALUES (?, 'k1', 'image', 'image/jpeg', 'view', 2048, 1)",
    )
      .bind(id)
      .run();
    const r = await get(env, "bbox=15,47,15.5,47.5");
    const c = (r.body as PackResponse).caches[0]!;
    expect(c).toMatchObject({
      hint: "under the stone",
      description: "a fine view",
      stages: [{ stageNo: 1, unlock: "nfc" }],
    });
    expect(c.logs.map((l) => l.loggerCall)).toEqual(["OE8L7", "OE8L6", "OE8L5", "OE8L4", "OE8L3"]);
    expect(c.images).toEqual([{ id: 1, url: "/api/media/k1", contentType: "image/jpeg", title: "view", bytes: 2048 }]);
    const text = JSON.stringify(r.body);
    for (const secret of ["TAG-SECRET", "the oak", "47.2"]) expect(text).not.toContain(secret);
  });

  it("includes the federated caches the map shows, marked as mirrored", async () => {
    const env = setup();
    await env.DB.prepare(
      "INSERT INTO fed_peers (url, instance, trust, added_via) VALUES ('https://peer.example', 'peer.example', 'trusted', 'manual')",
    ).run();
    await env.DB.prepare(
      `INSERT INTO remote_caches (global_id, origin, code, owner_call, title, type, status, difficulty, terrain, lat, lon, source, hint, mirrored_at)
       VALUES ('peer.example:cache:9', 'peer.example', 'PX-9', 'OE1X', 'Remote', 'traditional', 'active', 1, 1, 47.1, 15.1, 'native', 'remote hint', 1)`,
    ).run();
    const r = await get(env, "bbox=15,47,15.5,47.5");
    expect((r.body as PackResponse).caches).toMatchObject([
      { code: "PX-9", mirrored: true, origin: "peer.example", hint: "remote hint" },
    ]);
  });
});

describe("refresh and limits", () => {
  it("answers 304 to an unchanged area, and a new pack once something changed", async () => {
    const env = setup();
    const id = await cache(env, "AC-R", 47.1, 15.1);
    const first = await get(env, "bbox=15,47,15.5,47.5");
    expect(first.etag).toBe(`"${(first.body as PackResponse).generation}"`);
    expect((await get(env, "bbox=15,47,15.5,47.5", { "if-none-match": first.etag! })).status).toBe(304);
    await env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, 'OE8N', 5, 'note', 0)",
    )
      .bind(id)
      .run();
    expect((await get(env, "bbox=15,47,15.5,47.5", { "if-none-match": first.etag! })).status).toBe(200);
  });

  it("limits full builds per address", async () => {
    const env = setup();
    const from = { "cf-connecting-ip": "192.0.2.7" };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push(
        (await serve(env)(new Request("https://pack.example/api/offline/pack?bbox=15,47,15.5,47.5", { headers: from })))
          .status,
      );
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
