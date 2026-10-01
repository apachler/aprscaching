// SPDX-License-Identifier: AGPL-3.0-or-later
// The IndexedDB store the app keeps its packs, images, tiles and log queue in (fake-indexeddb stands in for
// the browser's).
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { idbStore, type PackMeta } from "../src/offline/store.js";

const meta = (id: string): PackMeta => ({
  id,
  name: id,
  area: { locator: "JN77" },
  filters: { types: [] },
  images: "thumbs",
  instance: "x",
  createdAt: 1,
  refreshedAt: 1,
  generation: "g",
  cacheCount: 0,
  sizeBytes: 0,
});

describe("the IndexedDB store", () => {
  it("keeps a pack, its caches and its blobs, and deletes them together", async () => {
    const st = idbStore();
    await st.putPack(meta("a"), []);
    await st.putBlob("a", "thumb:1", new Blob(["x"]));
    await st.putBlobs("a", [
      ["tile:0/0/0", new Blob(["t0"])],
      ["tile:1/0/0", new Blob(["t1"])],
    ]);
    await st.putPack(meta("b"), []);
    await st.putBlob("b", "thumb:9", new Blob(["y"]));
    expect((await st.packs()).map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect((await st.blobKeys("a")).sort()).toEqual(["thumb:1", "tile:0/0/0", "tile:1/0/0"]);
    expect(await (await st.blob("a", "tile:1/0/0"))!.text()).toBe("t1");
    await st.deleteBlob("a", "thumb:1");
    expect(await st.blob("a", "thumb:1")).toBeNull();
    await st.deletePack("a");
    expect((await st.packs()).map((p) => p.id)).toEqual(["b"]);
    expect(await st.blobKeys("a")).toEqual([]);
    expect(await st.blobKeys("b")).toEqual(["thumb:9"]);
  });

  it("updates a pack's description without touching its caches", async () => {
    const st = idbStore();
    await st.putPack(meta("c"), [{ code: "AC-1" } as never]);
    await st.touchPack({ ...meta("c"), refreshedAt: 50 });
    expect((await st.packs()).find((p) => p.id === "c")?.refreshedAt).toBe(50);
    expect(await st.packCaches("c")).toHaveLength(1);
  });

  it("keeps small records as key and value", async () => {
    const st = idbStore();
    expect(await st.kvGet("acs.nothing")).toBeNull();
    await st.kvSet("acs.logqueue", "[1]");
    expect(await st.kvGet("acs.logqueue")).toBe("[1]");
  });
});
