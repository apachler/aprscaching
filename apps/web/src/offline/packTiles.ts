// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Drawing the packs' map tiles offline: the `acs-pack://{z}/{x}/{y}` protocol answers MapLibre's tile
 * requests from the packs in IndexedDB (any pack holding the tile), and an empty tile where none does, so
 * the map shows blank land rather than errors past a pack's edge.
 */
import { addProtocol } from "maplibre-gl";
import type { OfflineStore } from "./store.js";
import { tileKey } from "./tiles.js";

export const PACK_TILES_SCHEME = "acs-pack";

/** Which pack holds each tile; rebuilt after a pack changes. */
let index: Promise<Map<string, string>> | null = null;
let storeRef: (() => Promise<OfflineStore>) | null = null;

/** Forget the tile index (a pack was saved, refreshed or deleted). */
export function invalidatePackTiles(): void {
  index = null;
}

async function buildIndex(store: OfflineStore): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const p of await store.packs())
    if (p.tiles) for (const k of await store.blobKeys(p.id)) if (k.startsWith("tile:") && !m.has(k)) m.set(k, p.id);
  return m;
}

/** The packs' tiles as one map source, when any pack holds tiles: the deepest zoom and the attribution. */
export async function packTilesSummary(store: OfflineStore): Promise<{ maxZoom: number; attribution: string } | null> {
  const withTiles = (await store.packs()).filter((p) => p.tiles);
  if (!withTiles.length) return null;
  return {
    maxZoom: Math.max(...withTiles.map((p) => p.tiles!.maxZoom)),
    attribution: [...new Set(withTiles.map((p) => p.tiles!.attribution))].join(" · "),
  };
}

/** Register the protocol once; `getStore` gives the offline store. */
export function registerPackTiles(getStore: () => Promise<OfflineStore>): void {
  if (storeRef) return;
  storeRef = getStore;
  addProtocol(PACK_TILES_SCHEME, async (params) => {
    const m = /^acs-pack:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m || !storeRef) return { data: new ArrayBuffer(0) };
    const store = await storeRef();
    index ??= buildIndex(store);
    const key = tileKey(Number(m[1]), Number(m[2]), Number(m[3]));
    const packId = (await index).get(key);
    const blob = packId ? await store.blob(packId, key) : null;
    return { data: blob ? await blob.arrayBuffer() : new ArrayBuffer(0) };
  });
}
