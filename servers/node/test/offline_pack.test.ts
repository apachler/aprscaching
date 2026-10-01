// SPDX-License-Identifier: AGPL-3.0-or-later
// The offline pack: the caches of a box, a circle or a route corridor with what the cache page needs
// offline, never a stage's secrets; capped, refused when too large, and cheap to refresh when unchanged.
import { describe, it, expect } from "vitest";
import { PACK_LOGS_PER_CACHE, type PackResponse } from "@aprscaching/shared";
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
  it("a locator square takes the caches inside it, never archived ones", async () => {
    const env = setup();
    await cache(env, "AC-IN", 47.1, 15.1); // JN77
    await cache(env, "AC-OUT", 48.5, 15.1); // JN78
    await cache(env, "AC-GONE", 47.2, 15.2, { status: "archived" });
    const r = await get(env, "grid=JN77");
    expect(r.status).toBe(200);
    expect(codes(r.body as PackResponse)).toEqual(["AC-IN"]);
  });

  it("a longer locator is a smaller square", async () => {
    const env = setup();
    await cache(env, "AC-SB", 47.06, 15.54); // JN77sb: 15.50–15.58°E, 47.04–47.08°N
    await cache(env, "AC-NEXT", 47.06, 15.6); // JN77tb
    expect(codes((await get(env, "grid=jn77sb")).body as PackResponse)).toEqual(["AC-SB"]);
    expect(codes((await get(env, "grid=JN")).body as PackResponse)).toEqual(["AC-NEXT", "AC-SB"]);
  });

  it("filters by type", async () => {
    const env = setup();
    await cache(env, "AC-T", 47.1, 15.1);
    await cache(env, "AC-M", 47.1, 15.2, { type: "multi" });
    expect(codes((await get(env, "grid=JN77&types=multi")).body as PackResponse)).toEqual(["AC-M"]);
  });

  it("refuses anything but a locator", async () => {
    const env = setup();
    for (const q of ["", "grid=JN7", "grid=ZZ77", "grid=JN77sz", "bbox=15,47,16,48"])
      expect((await get(env, q)).status, q).toBe(400);
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
    const r = await get(env, "grid=JN77");
    const c = (r.body as PackResponse).caches[0]!;
    expect(c).toMatchObject({
      hint: "under the stone",
      description: "a fine view",
      stages: [{ stageNo: 1, unlock: "nfc" }],
    });
    expect(c.logs.map((l) => l.loggerCall)).toEqual(["OE8L7", "OE8L6", "OE8L5", "OE8L4", "OE8L3"]);
    expect(c.images).toEqual([
      {
        id: 1,
        url: "/api/media/k1",
        contentType: "image/jpeg",
        title: "view",
        bytes: 2048,
        thumbUrl: null,
        thumbBytes: null,
      },
    ]);
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
    const r = await get(env, "grid=JN77");
    expect((r.body as PackResponse).caches).toMatchObject([
      { code: "PX-9", mirrored: true, origin: "peer.example", hint: "remote hint" },
    ]);
  });
});

describe("refresh and limits", () => {
  it("answers 304 to an unchanged area, and a new pack once something changed", async () => {
    const env = setup();
    const id = await cache(env, "AC-R", 47.1, 15.1);
    const first = await get(env, "grid=JN77");
    expect(first.etag).toBe(`"${(first.body as PackResponse).generation}"`);
    expect((await get(env, "grid=JN77", { "if-none-match": first.etag! })).status).toBe(304);
    await env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, 'OE8N', 5, 'note', 0)",
    )
      .bind(id)
      .run();
    expect((await get(env, "grid=JN77", { "if-none-match": first.etag! })).status).toBe(200);
  });

  it("limits full builds per address", async () => {
    const env = setup();
    const from = { "cf-connecting-ip": "192.0.2.7" };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push(
        (await serve(env)(new Request("https://pack.example/api/offline/pack?grid=JN77", { headers: from }))).status,
      );
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("image thumbnails", () => {
  /** A media store in memory, and an image on a cache. */
  async function withImage() {
    const objects = new Map<string, Uint8Array>();
    const env = instanceEnv("pack.example", null, {
      MEDIA: {
        put: async (k: string, b: Uint8Array) => void objects.set(k, b),
        get: async (k: string) => (objects.has(k) ? { bytes: objects.get(k)!, contentType: "image/jpeg" } : null),
        delete: async (k: string) => void objects.delete(k),
      },
    }) as unknown as Env;
    const id = await cache(env, "AC-PIC", 47.1, 15.1);
    const up = await serve(env)(
      new Request(`https://pack.example/api/caches/${id}/media?title=view`, {
        method: "POST",
        headers: { "content-type": "image/jpeg", "x-ingest-secret": "test-ingest-secret", "x-owner-call": "OE8OWN" },
        body: new Uint8Array(5000),
      }),
    );
    const mediaId = ((await up.json()) as { item: { id: number } }).item.id;
    const thumb = (body: BodyInit, headers: Record<string, string> = {}) =>
      serve(env)(
        new Request(`https://pack.example/api/caches/${id}/media/${mediaId}/thumb`, {
          method: "PUT",
          headers: {
            "content-type": "image/jpeg",
            "x-ingest-secret": "test-ingest-secret",
            "x-owner-call": "OE8OWN",
            ...headers,
          },
          body,
        }),
      );
    return { env, id, mediaId, objects, thumb };
  }

  it("the owner stores one, and the gallery and the pack list it beside the image", async () => {
    const t = await withImage();
    expect((await t.thumb(new Uint8Array(800))).status).toBe(200);
    const list = (await (await serve(t.env)(new Request(`https://pack.example/api/caches/${t.id}/media`))).json()) as {
      media: { thumbUrl?: string; thumbBytes?: number; bytes: number }[];
    };
    expect(list.media[0]).toMatchObject({ bytes: 5000, thumbBytes: 800 });
    expect(list.media[0]!.thumbUrl).toMatch(/^\/api\/media\/cache\/.+\.thumb\.jpeg$/);
    const pack = (await get(t.env, "grid=JN77")).body as PackResponse;
    expect(pack.caches[0]!.images[0]).toMatchObject({ thumbUrl: list.media[0]!.thumbUrl, thumbBytes: 800 });
  });

  it("only the owner, only a small JPEG or WebP", async () => {
    const t = await withImage();
    expect((await t.thumb(new Uint8Array(800), { "x-owner-call": "OE1XYZ" })).status).toBe(403);
    expect((await t.thumb(new Uint8Array(800), { "content-type": "image/png" })).status).toBe(415);
    expect((await t.thumb(new Uint8Array(200_000))).status).toBe(413);
  });

  it("a new one replaces the old, and deleting the image deletes both", async () => {
    const t = await withImage();
    await t.thumb(new Uint8Array(800));
    await t.thumb(new Uint8Array(900));
    expect([...t.objects.keys()].filter((k) => k.includes(".thumb.")).length).toBe(1);
    await serve(t.env)(
      new Request(`https://pack.example/api/caches/${t.id}/media/${t.mediaId}`, {
        method: "DELETE",
        headers: { "x-ingest-secret": "test-ingest-secret", "x-owner-call": "OE8OWN" },
      }),
    );
    expect(t.objects.size).toBe(0);
  });
});
