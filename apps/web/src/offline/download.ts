// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Downloading and refreshing an offline pack. First the pack's data (GET /api/offline/pack), which tells
 * what the images would cost; the user picks the images then, and the pack is stored only once complete.
 *
 * Images: `thumbs` keeps the thumbnail the instance stores beside each cache's first image (a few
 * kilobytes); `full` keeps every image as stored. A pack, its images included, stays within PACK_MAX_BYTES.
 *
 * A refresh sends the pack's generation and keeps everything when the instance says nothing changed;
 * otherwise it stores the new data and fetches only the images it does not hold yet.
 */
import {
  PACK_MAX_BYTES,
  packAreaQuery,
  type PackArea,
  type PackCache,
  type PackImage,
  type PackResponse,
} from "@aprscaching/shared";
import type { OfflineStore, PackMeta } from "./store.js";

const PARALLEL = 4;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The pack data for an area, or `unchanged` when `generation` is still current. */
export async function fetchPackData(
  fetcher: Fetcher,
  base: string,
  area: PackArea,
  filters: { types: string[] },
  generation?: string,
): Promise<PackResponse | "unchanged"> {
  const q = packAreaQuery(area) + (filters.types.length ? `&types=${filters.types.join(",")}` : "");
  const res = await fetcher(`${base}/api/offline/pack?${q}`, {
    credentials: "include",
    headers: generation ? { "if-none-match": `"${generation}"` } : {},
  });
  if (res.status === 304) return "unchanged";
  const body = (await res.json().catch(() => ({}))) as PackResponse & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `the instance answered ${res.status}`);
  return body;
}

/** The images a pack keeps for each cache with the chosen option: every image, or the first one's thumbnail. */
export function imagesFor(c: PackCache, option: PackMeta["images"]): PackImage[] {
  if (option === "full") return c.images;
  if (option === "thumbs") return c.images.filter((i) => i.thumbUrl).slice(0, 1);
  return [];
}
/** What a pack downloads for one image with the chosen option. */
const sourceOf = (img: PackImage, option: PackMeta["images"]) =>
  option === "thumbs" && img.thumbUrl ? img.thumbUrl : img.url;

export interface PackEstimate {
  caches: number;
  /** The pack's data as stored. */
  dataBytes: number;
  /** The thumbnails of the caches' first images. */
  thumbsBytes: number;
  /** Every image as published. */
  fullBytes: number;
  /** Does the pack stay within the size limit with full images? */
  fullFits: boolean;
}

export function estimatePack(data: PackResponse): PackEstimate {
  const dataBytes = JSON.stringify(data.caches).length;
  let thumbsBytes = 0,
    fullBytes = 0;
  for (const c of data.caches) {
    for (const i of imagesFor(c, "thumbs")) thumbsBytes += i.thumbBytes ?? 0;
    for (const i of c.images) fullBytes += i.bytes;
  }
  return {
    caches: data.caches.length,
    dataBytes,
    thumbsBytes,
    fullBytes,
    fullFits: dataBytes + fullBytes <= PACK_MAX_BYTES,
  };
}

/** The key an image is stored under in its pack. */
export const imageKey = (img: PackImage, option: PackMeta["images"]) =>
  `${option === "full" ? "full" : "thumb"}:${img.id}`;

export interface SaveProgress {
  done: number;
  total: number;
}

/**
 * Store a pack: its images first (only the ones the pack does not hold yet), then its data and
 * description, so an interrupted download leaves the previous version of the pack intact.
 */
export async function storePack(
  store: OfflineStore,
  fetcher: Fetcher,
  base: string,
  meta: Omit<PackMeta, "sizeBytes" | "cacheCount" | "generation" | "instance">,
  data: PackResponse,
  opts: { onProgress?: (p: SaveProgress) => void; signal?: AbortSignal } = {},
): Promise<PackMeta> {
  const wanted = data.caches.flatMap((c) => imagesFor(c, meta.images));
  const have = new Set(await store.blobKeys(meta.id));
  const todo = wanted.filter((i) => !have.has(imageKey(i, meta.images)));
  let bytes = JSON.stringify(data.caches).length;
  for (const k of have)
    if (wanted.some((i) => imageKey(i, meta.images) === k)) bytes += (await store.blob(meta.id, k))?.size ?? 0;
  let done = 0;
  opts.onProgress?.({ done, total: todo.length });
  const queue = [...todo];
  const worker = async () => {
    for (let img = queue.shift(); img; img = queue.shift()) {
      if (opts.signal?.aborted) throw new DOMException("the download was stopped", "AbortError");
      try {
        const res = await fetcher(base + sourceOf(img, meta.images), { signal: opts.signal });
        if (res.ok) {
          const kept = await res.blob();
          if (bytes + kept.size <= PACK_MAX_BYTES) {
            await store.putBlob(meta.id, imageKey(img, meta.images), kept);
            bytes += kept.size;
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        /* one image that does not load leaves the pack without it */
      }
      opts.onProgress?.({ done: ++done, total: todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  // images the pack no longer lists (removed, or another image option) are dropped
  const keep = new Set(wanted.map((i) => imageKey(i, meta.images)));
  for (const k of have) if (!keep.has(k)) await store.deleteBlob(meta.id, k);
  const full: PackMeta = {
    ...meta,
    instance: data.instance,
    generation: data.generation,
    cacheCount: data.caches.length,
    sizeBytes: bytes,
  };
  await store.putPack(full, data.caches);
  return full;
}

/** Refresh a pack: nothing to fetch when unchanged, else the new data and the images it lacks. */
export async function refreshPack(
  store: OfflineStore,
  fetcher: Fetcher,
  base: string,
  meta: PackMeta,
  now: number,
  opts: { onProgress?: (p: SaveProgress) => void; signal?: AbortSignal } = {},
): Promise<{ meta: PackMeta; changed: boolean }> {
  if (!meta.area) throw new Error("the automatic area is kept as you browse; it has nothing to refresh");
  const data = await fetchPackData(fetcher, base, meta.area, meta.filters, meta.generation);
  if (data === "unchanged") {
    const touched = { ...meta, refreshedAt: now };
    await store.touchPack(touched);
    return { meta: touched, changed: false };
  }
  return { meta: await storePack(store, fetcher, base, { ...meta, refreshedAt: now }, data, opts), changed: true };
}
