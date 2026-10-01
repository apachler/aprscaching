// SPDX-License-Identifier: AGPL-3.0-or-later
// A pack's map tiles: which tiles a locator square covers, how deep a pack can go within its size limit,
// and the download, read through the real PMTiles reader from a small archive built here.
import { describe, it, expect } from "vitest";
import { PMTiles, type Source } from "pmtiles";
import { buildArchive } from "./fixtures/pmtiles.js";
import { locatorBounds, type PackResponse } from "@aprscaching/shared";
import { memoryStore } from "../src/offline/store.js";
import { downloadTiles, planTiles, tileKey, tileRange } from "../src/offline/tiles.js";
import { storePack } from "../src/offline/download.js";

const memorySource = (bytes: Uint8Array): Source => ({
  getKey: () => "memory",
  getBytes: async (offset, length) => ({ data: bytes.slice(offset, offset + length).buffer as ArrayBuffer }),
});

const JN77 = locatorBounds("JN77");

describe("the tiles of a square", () => {
  it("covers JN77 with one tile at low zoom and a block deeper down", () => {
    expect(tileRange(JN77, 0)).toMatchObject({ x0: 0, x1: 0, y0: 0, y1: 0, count: 1 });
    expect(tileRange(JN77, 6)).toMatchObject({ x0: 34, x1: 34, y0: 22, y1: 22, count: 1 });
    expect(tileRange(JN77, 10)).toMatchObject({ x0: 551, x1: 557, count: 7 * 6 }); // 14–16°E, 47–48°N
  });

  it("goes as deep as the size limit allows", () => {
    const info = { minZoom: 0, maxZoom: 14, numTileContents: 100, tileDataLength: 100 * 10_000 }; // 10 kB a tile
    const all = planTiles(info, JN77, 14, 1e12)!;
    expect(all.maxZoom).toBe(14);
    const tight = planTiles(info, JN77, 14, 2_000_000)!;
    expect(tight.maxZoom).toBeLessThan(14);
    expect(tight.estBytes).toBeLessThanOrEqual(2_000_000);
    expect(planTiles(info, JN77, 10, 1e12)!.maxZoom).toBe(10); // the instance's own limit
    expect(planTiles(info, JN77, 14, 5_000)).toBeNull(); // not even zoom 0 fits
  });
});

describe("downloading tiles through the PMTiles reader", () => {
  const archive = () =>
    new PMTiles(
      memorySource(
        buildArchive([
          { z: 0, x: 0, y: 0, bytes: [1, 2, 3] },
          { z: 6, x: 34, y: 22, bytes: [4, 5] },
          { z: 6, x: 35, y: 22, bytes: [9] }, // outside JN77
        ]),
      ),
    );

  it("keeps the square's tiles the archive has, skips the rest, and keeps what a pack holds already", async () => {
    const st = memoryStore();
    const reader = archive();
    const h = await reader.getHeader();
    expect([h.minZoom, h.maxZoom, h.numTileContents]).toEqual([0, 6, 3]);
    const plan = planTiles({ ...h }, JN77, 6, 1e9)!;
    const bytes = await downloadTiles(st, "p", reader, plan, JN77);
    expect(bytes).toBe(5);
    expect((await st.blobKeys("p")).sort()).toEqual([tileKey(0, 0, 0), tileKey(6, 34, 22)]);
    expect([...new Uint8Array(await (await st.blob("p", tileKey(6, 34, 22)))!.arrayBuffer())]).toEqual([4, 5]);
    const again = await downloadTiles(st, "p", reader, plan, JN77);
    expect(again).toBe(0);
  });

  it("stores a pack's tiles with it and records them", async () => {
    const st = memoryStore();
    const reader = archive();
    const plan = planTiles(await reader.getHeader(), JN77, 6, 1e9)!;
    const data: PackResponse = { instance: "x", generation: "g", builtAt: 1, caches: [] };
    const meta = await storePack(
      st,
      async () => new Response("x"),
      "",
      {
        id: "p",
        name: "JN77",
        area: { locator: "JN77" },
        filters: { types: [] },
        images: "none",
        createdAt: 1,
        refreshedAt: 1,
      },
      data,
      { tiles: { reader, plan, attribution: "© OSM" } },
    );
    expect(meta.tiles).toMatchObject({ minZoom: 0, maxZoom: 6, bytes: 5, attribution: "© OSM" });
    expect(meta.sizeBytes).toBeGreaterThanOrEqual(5);
  });
});
