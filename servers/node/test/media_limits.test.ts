// SPDX-License-Identifier: AGPL-3.0-or-later
// Media is bounded at every level, so it cannot fill the instance's disk: per item, per cache, per account across
// its caches, and the instance's own MEDIA_QUOTA_MB.
import { describe, it, expect } from "vitest";
import { authEnv, call, hiderSignup } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const media = () => ({ put: async () => {}, get: async () => null, delete: async () => {} });

async function owner(extra: Record<string, unknown> = {}) {
  const env = authEnv({ MEDIA: media(), HIDE_DAILY_LIMIT: "0", ...extra });
  const who = await hiderSignup(env, "limits@example.test", "OE8LIM");
  const hide = async () =>
    (
      await call(
        env,
        "POST",
        "/api/caches",
        { title: "oak", type: "traditional", lat: 47, lon: 15 },
        {
          cookie: who.cookie,
        },
      )
    ).data.cache.id as number;
  const upload = (
    cacheId: number,
    contentType: string,
    size: number,
    path = `/api/caches/${cacheId}/media`,
    method = "POST",
  ) =>
    serve(env)(
      new Request(`https://gw.test${path}`, {
        method,
        headers: { "content-type": contentType, cookie: who.cookie!, "x-real-ip": "192.0.2.10" },
        body: new Uint8Array(size),
      }),
    );
  return { env, who, hide, upload };
}

/** Pretend `bytes` of gallery media is already stored on a cache. */
const stored = (env: Env, cacheId: number, bytes: number) =>
  env.DB.prepare(
    "INSERT INTO cache_media (cache_id, media_key, kind, content_type, bytes, created_at) VALUES (?, ?, 'image', 'image/jpeg', ?, 0)",
  )
    .bind(cacheId, `k${Math.random()}`, bytes)
    .run();

describe("media limits", () => {
  it("bound a photo at 2 MB and a sound at 3 MB", async () => {
    const o = await owner();
    const id = await o.hide();
    expect((await o.upload(id, "image/jpeg", 2_000_001)).status).toBe(413);
    expect((await o.upload(id, "image/jpeg", 2_000_000)).status).toBe(201);
    expect((await o.upload(id, "audio/mpeg", 3_000_001)).status).toBe(413);
    expect((await o.upload(id, "audio/mpeg", 3_000_000)).status).toBe(201);
  });

  it("hold six items and 10 MB on a cache", async () => {
    const o = await owner();
    const id = await o.hide();
    for (let i = 0; i < 6; i++) expect((await o.upload(id, "image/jpeg", 1000)).status).toBe(201);
    expect((await o.upload(id, "image/jpeg", 1000)).status).toBe(409);

    const other = await o.hide();
    for (let i = 0; i < 3; i++) expect((await o.upload(other, "audio/mpeg", 3_000_000)).status).toBe(201);
    const over = await o.upload(other, "image/jpeg", 1_500_000);
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toMatch(/this cache holds at most 10 MB/);
  });

  it("count a stage's audio clue, and a replaced clue frees its room", async () => {
    const o = await owner();
    const id = await o.hide();
    await call(
      o.env,
      "POST",
      `/api/caches/${id}/stages`,
      { stages: [{ stageNo: 0, unlock: "open", lat: 47, lon: 15 }] },
      {
        cookie: o.who.cookie,
      },
    );
    await stored(o.env, id, 7_500_000);
    const clue = (size: number) => o.upload(id, "audio/ogg", size, `/api/caches/${id}/stages/0/media`, "PUT");
    expect((await clue(2_500_000)).status).toBe(200);
    expect((await clue(2_500_000)).status).toBe(200); // replaces the first: still 10 MB in all
    expect((await o.upload(id, "image/jpeg", 1000)).status).toBe(413);
  });

  it("hold 50 MB across every cache of one account", async () => {
    const o = await owner();
    for (let i = 0; i < 5; i++) await stored(o.env, await o.hide(), 10_000_000);
    const res = await o.upload(await o.hide(), "image/jpeg", 1000);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/your caches hold at most 50 MB/);
  });

  it("stop at the instance's MEDIA_QUOTA_MB, whoever uploads", async () => {
    const o = await owner({ MEDIA_QUOTA_MB: "1" });
    const id = await o.hide();
    expect((await o.upload(id, "image/jpeg", 600_000)).status).toBe(201);
    const res = await o.upload(id, "image/jpeg", 600_000);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/storage is full/);
  });
});
