// SPDX-License-Identifier: AGPL-3.0-or-later
// Cache media is photos and sound only, and the instance serves whatever its store holds as inert content.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";

function store() {
  const items = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    items,
    put: async (key: string, bytes: Uint8Array, contentType: string) => void items.set(key, { bytes, contentType }),
    get: async (key: string) => items.get(key) ?? null,
    delete: async (key: string) => void items.delete(key),
  };
}

async function world() {
  const media = store();
  const env = authEnv({ MEDIA: media });
  const owner = await emailSignup(env, "media@example.test", "OE8MED");
  const made = await call(
    env,
    "POST",
    "/api/caches",
    { title: "oak", type: "traditional", lat: 47, lon: 15 },
    {
      cookie: owner.cookie,
    },
  );
  const upload = (contentType: string, path = `/api/caches/${made.data.cache.id}/media`, method = "POST") =>
    serve(env)(
      new Request(`https://gw.test${path}`, {
        method,
        headers: { "content-type": contentType, cookie: owner.cookie!, "x-real-ip": "192.0.2.10" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
  return { env, media, upload, owner, cacheId: made.data.cache.id as number };
}

describe("cache media", () => {
  it("takes photos and sound, and refuses anything a browser would run", async () => {
    const w = await world();
    expect((await w.upload("image/jpeg")).status).toBe(201);
    expect((await w.upload("audio/mpeg; codecs=mp3")).status).toBe(201);
    for (const ct of ["text/html", "image/svg+xml", "application/javascript", "application/pdf", "application/zip"])
      expect((await w.upload(ct)).status, ct).toBe(415);
  });

  it("takes only sound as a stage's audio clue", async () => {
    const w = await world();
    const set = await call(
      w.env,
      "POST",
      `/api/caches/${w.cacheId}/stages`,
      { stages: [{ stageNo: 0, unlock: "open", lat: 47, lon: 15 }] },
      { cookie: w.owner.cookie },
    );
    expect(set.status).toBe(200);
    const clue = (ct: string) => w.upload(ct, `/api/caches/${w.cacheId}/stages/0/media`, "PUT");
    expect((await clue("text/html")).status).toBe(415);
    expect((await clue("audio/ogg")).status).toBe(200);
  });

  it("serves media inert, and anything that is not a photo or a sound only as a download", async () => {
    const w = await world();
    await w.upload("image/png");
    const [photoKey] = [...w.media.items.keys()];
    const photo = await serve(w.env)(new Request(`https://gw.test/api/media/${photoKey}`));
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(photo.headers.get("content-security-policy")).toContain("sandbox");
    expect(photo.headers.get("content-disposition")).toBeNull();

    w.media.items.set("cache/1/media/00000000-0000-4000-8000-000000000001.html", {
      bytes: new Uint8Array([60]),
      contentType: "text/html",
    });
    const page = await serve(w.env)(
      new Request("https://gw.test/api/media/cache/1/media/00000000-0000-4000-8000-000000000001.html"),
    );
    expect(page.headers.get("content-type")).toBe("application/octet-stream");
    expect(page.headers.get("content-disposition")).toBe("attachment");
  });
});
