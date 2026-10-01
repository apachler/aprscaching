// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The map tiles of an offline pack. The instance serves its operator's regional PMTiles archive
 * (GET /api/offline/tiles names it); a pack reads the archive's directory by byte range and keeps the
 * vector tiles of its locator square, from the whole world at zoom 0 down to the most detailed zoom that
 * still fits the pack's size limit. Offline, the map draws them through the `acs-pack://` protocol
 * (packTiles.ts). Tiles never come from a third-party tile service.
 */
import { PACK_MAX_BYTES } from "@aprscaching/shared";
import type { OfflineStore } from "./store.js";

export interface TilesConfig {
  /** The archive's URL (a path is on the instance), or null when the instance offers no offline map. */
  url: string | null;
  attribution: string;
  maxZoom: number;
}

/** What a pack's tiles will be: the zooms, how many tiles, and about how many bytes. */
export interface TilePlan {
  minZoom: number;
  maxZoom: number;
  count: number;
  estBytes: number;
}

/** The archive facts a plan needs (a PMTiles header). */
export interface ArchiveInfo {
  minZoom: number;
  maxZoom: number;
  numTileContents: number;
  tileDataLength?: number;
}

/** Reads one tile; undefined when the archive has none there. */
export interface TileReader {
  getZxy(z: number, x: number, y: number, signal?: AbortSignal): Promise<{ data: ArrayBuffer } | undefined>;
}

type Bounds = [minLon: number, minLat: number, maxLon: number, maxLat: number];

const MAX_LAT = 85.0511287798;
const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** The tile columns and rows a box covers at zoom `z` (Web Mercator, y from the north). */
export function tileRange(b: Bounds, z: number): { x0: number; x1: number; y0: number; y1: number; count: number } {
  const n = 2 ** z;
  const x = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const y = (lat: number) => {
    const r = (clampLat(lat) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  const x0 = x(b[0]),
    x1 = x(b[2]),
    y0 = y(b[3]),
    y1 = y(b[1]);
  return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

/**
 * The most detailed plan within `budgetBytes`: every zoom from the archive's least detailed up to the
 * deepest one whose cumulative estimate fits (never past `maxZoom`). The estimate uses the archive's
 * average tile size. Null when not even the least detailed zoom fits.
 */
export function planTiles(info: ArchiveInfo, bounds: Bounds, maxZoom: number, budgetBytes: number): TilePlan | null {
  const avg = info.numTileContents > 0 && info.tileDataLength ? info.tileDataLength / info.numTileContents : 20_000;
  let plan: TilePlan | null = null;
  let count = 0;
  for (let z = info.minZoom; z <= Math.min(info.maxZoom, maxZoom); z++) {
    count += tileRange(bounds, z).count;
    const estBytes = Math.round(count * avg);
    if (estBytes > budgetBytes) break;
    plan = { minZoom: info.minZoom, maxZoom: z, count, estBytes };
  }
  return plan;
}

/** The budget left for tiles once the pack's data and images are counted. */
export const tileBudget = (otherBytes: number) => Math.max(0, PACK_MAX_BYTES - otherBytes);

export const tileKey = (z: number, x: number, y: number) => `tile:${z}/${x}/${y}`;

/**
 * Download a plan's tiles into the pack, a batch at a time. Tiles the pack already holds are kept as they
 * are; a tile the archive does not have is skipped (the sea, beyond the extract). Returns the bytes stored.
 */
export async function downloadTiles(
  store: OfflineStore,
  packId: string,
  reader: TileReader,
  plan: TilePlan,
  bounds: Bounds,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<number> {
  const have = new Set((await store.blobKeys(packId)).filter((k) => k.startsWith("tile:")));
  let done = 0,
    bytes = 0;
  const batch: [string, Blob][] = [];
  const flush = async () => {
    if (batch.length) await store.putBlobs(packId, batch.splice(0));
  };
  for (let z = plan.minZoom; z <= plan.maxZoom; z++) {
    const r = tileRange(bounds, z);
    for (let x = r.x0; x <= r.x1; x++)
      for (let y = r.y0; y <= r.y1; y++) {
        if (opts.signal?.aborted) throw new DOMException("the download was stopped", "AbortError");
        const key = tileKey(z, x, y);
        if (!have.has(key)) {
          const t = await reader.getZxy(z, x, y, opts.signal);
          if (t?.data.byteLength) {
            batch.push([key, new Blob([t.data])]);
            bytes += t.data.byteLength;
            if (batch.length >= 64) await flush();
          }
        }
        opts.onProgress?.(++done, plan.count);
      }
  }
  await flush();
  return bytes;
}
