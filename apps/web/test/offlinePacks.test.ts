// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import type { MapCache, PackCache, PackResponse } from "@aprscaching/shared";
import { memoryStore, type PackMeta } from "../src/offline/store.js";
import { packCache, packCachesInBox, packSearch, saveAutoArea, userPacks } from "../src/offline/packs.js";
import { estimatePack, imageKey, refreshPack, storePack, type Fetcher } from "../src/offline/download.js";

const map = (id: number, lat = 47.1, lon = 15.1): MapCache => ({
  globalId: `x:cache:${id}`,
  id,
  code: `AC-${id}`,
  ownerCall: "OE8OWN",
  title: `Cache ${id}`,
  type: "traditional",
  status: "active",
  difficulty: 1,
  terrain: 1,
  lat,
  lon,
  origin: "x",
  mirrored: false,
  originTrust: "native",
  source: "native",
  sourceName: null,
  sourceUrl: null,
});
const full = (id: number, images: { id: number; bytes: number; thumb?: number }[] = []): PackCache => ({
  ...map(id),
  stationCall: null,
  minTrust: null,
  fedScope: "public",
  driveIn: false,
  country: null,
  tags: [],
  externalId: null,
  hint: "hint",
  description: "desc",
  createdAt: 1,
  updatedAt: 1,
  stages: [],
  logs: [],
  images: images.map((i) => ({
    id: i.id,
    url: `/api/media/k${i.id}`,
    contentType: "image/jpeg",
    title: null,
    bytes: i.bytes,
    thumbUrl: i.thumb ? `/api/media/t${i.id}` : null,
    thumbBytes: i.thumb ?? null,
  })),
});
const BOX: [number, number, number, number] = [15, 47, 15.5, 47.5];
const meta = (id: string, refreshedAt: number, extra: Partial<PackMeta> = {}): PackMeta => ({
  id,
  name: id,
  area: { locator: "JN77" },
  filters: { types: [] },
  images: "none",
  instance: "x",
  createdAt: refreshedAt,
  refreshedAt,
  generation: "g",
  cacheCount: 0,
  sizeBytes: 0,
  ...extra,
});

describe("reading packs offline", () => {
  it("shows each cache once, from the newest pack, with the automatic area last", async () => {
    const st = memoryStore();
    await saveAutoArea(st, [map(1), map(9)], "x", 50);
    await st.putPack(meta("old", 10), [full(1), full(2)]);
    await st.putPack(meta("new", 20, { name: "Saualpe" }), [full(2), full(3)]);
    const r = await packCachesInBox(st, BOX);
    expect(r.caches.map((c) => c.id).sort()).toEqual([1, 2, 3, 9]);
    expect(r.source).toMatchObject({ name: "Saualpe", auto: false, packs: 3 });
    expect((await packCache(st, 1))?.pack.id).toBe("old"); // the details over the automatic area's bare copy
    expect((await userPacks(st)).map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("searches the packs without a connection: each cache once, a code match first, no archived cache", async () => {
    const st = memoryStore();
    await saveAutoArea(st, [map(12)], "x", 50);
    await st.putPack(meta("p", 10), [
      { ...full(1), title: "Schlossberg clock tower" },
      { ...full(12), title: "Am Schlossberg" },
      { ...full(3), title: "Schlossberg cellar", status: "archived" },
    ]);
    const hits = await packSearch(st, "schlossberg", 8);
    expect(hits.map((h) => h.code)).toEqual(["AC-1", "AC-12"]);
    expect((await packSearch(st, "ac-12", 8)).map((h) => h.code)).toEqual(["AC-12"]);
    expect(await packSearch(st, "x", 8)).toEqual([]);
  });

  it("returns nothing outside every pack", async () => {
    const st = memoryStore();
    await st.putPack(meta("p", 1), [full(1)]);
    expect(await packCachesInBox(st, [0, 0, 1, 1])).toEqual({ caches: [], source: null });
  });
});

describe("downloading a pack", () => {
  const pack = (caches: PackCache[], generation = "g1"): PackResponse => ({
    instance: "x",
    generation,
    builtAt: 1,
    caches,
  });
  const images = (fail: number[] = []) => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (fail.some((id) => url.endsWith(`/k${id}`))) return new Response("no", { status: 404 });
      return new Response(new Blob([new Uint8Array(1000)], { type: "image/jpeg" }));
    };
    return { calls, fetcher };
  };

  it("estimates the data and what each image option costs", () => {
    const e = estimatePack(
      pack([
        full(1, [
          { id: 1, bytes: 400_000, thumb: 9_000 },
          { id: 2, bytes: 100_000, thumb: 3_000 },
        ]),
        full(2),
      ]),
    );
    expect(e).toMatchObject({ caches: 2, thumbsBytes: 9_000, fullBytes: 500_000, fullFits: true });
  });

  it("keeps the instance's thumbnail of each cache's first image, never the photo itself", async () => {
    const st = memoryStore();
    const f = images();
    const m = await storePack(
      st,
      f.fetcher,
      "https://i",
      meta("p", 1, { images: "thumbs" }),
      pack([
        full(1, [
          { id: 1, bytes: 900_000, thumb: 8_000 },
          { id: 2, bytes: 9, thumb: 9 },
        ]),
        full(2, [{ id: 3, bytes: 5 }]), // no thumbnail stored: the pack keeps no image for it
      ]),
    );
    expect(f.calls).toEqual(["https://i/api/media/t1"]);
    expect(await st.blobKeys("p")).toEqual(["thumb:1"]);
    expect(m).toMatchObject({ cacheCount: 2, generation: "g1", instance: "x" });
  });

  it("leaves out an image that does not load, and keeps the rest", async () => {
    const st = memoryStore();
    const f = images([2]);
    await storePack(
      st,
      f.fetcher,
      "",
      meta("p", 1, { images: "full" }),
      pack([
        full(1, [
          { id: 1, bytes: 1 },
          { id: 2, bytes: 1 },
        ]),
      ]),
    );
    expect(await st.blobKeys("p")).toEqual(["full:1"]);
    expect(await st.packCaches("p")).toHaveLength(1);
  });

  it("stores nothing when the download is stopped", async () => {
    const st = memoryStore();
    const stop = new AbortController();
    stop.abort();
    await expect(
      storePack(st, images().fetcher, "", meta("p", 1, { images: "full" }), pack([full(1, [{ id: 1, bytes: 1 }])]), {
        signal: stop.signal,
      }),
    ).rejects.toThrow();
    expect(await st.packs()).toEqual([]);
  });

  it("a refresh keeps everything when unchanged, and fetches only new images otherwise", async () => {
    const st = memoryStore();
    const first = await storePack(
      st,
      images().fetcher,
      "",
      meta("p", 1, { images: "full" }),
      pack([full(1, [{ id: 1, bytes: 1 }])]),
    );
    const unchanged: Fetcher = async (_url, init) => {
      expect((init?.headers as Record<string, string>)["if-none-match"]).toBe('"g1"');
      return new Response(null, { status: 304 });
    };
    const r1 = await refreshPack(st, unchanged, "", first, 99);
    expect(r1).toMatchObject({ changed: false, meta: { refreshedAt: 99 } });

    const calls: string[] = [];
    const changed: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes("/api/offline/pack"))
        return Response.json(
          pack(
            [
              full(1, [
                { id: 1, bytes: 1 },
                { id: 3, bytes: 1 },
              ]),
              full(2),
            ],
            "g2",
          ),
        );
      return new Response(new Blob([new Uint8Array(10)]));
    };
    const r2 = await refreshPack(st, changed, "", r1.meta, 120);
    expect(r2.changed).toBe(true);
    expect(calls.filter((u) => u.includes("/api/media/"))).toEqual(["/api/media/k3"]);
    expect((await st.blobKeys("p")).sort()).toEqual([imageKey({ id: 1 } as never, "full"), "full:3"]);
    expect((await st.packs())[0]).toMatchObject({ generation: "g2", cacheCount: 2, refreshedAt: 120 });
  });
});
