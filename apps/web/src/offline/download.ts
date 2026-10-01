// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Downloading and refreshing an offline pack. First the pack's data (GET /api/offline/pack), which tells
 * what the images would cost; the user picks the images then, and the pack is stored only once complete.
 *
 * Images: `thumbs` keeps a small copy of each cache's first image, made on the phone (the instance stores
 * images as published, so the phone downloads each once and keeps a 320-pixel JPEG); `full` keeps every
 * image as published. A pack, its images included, stays within PACK_MAX_BYTES.
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

/** The longest side of a thumbnail, in pixels, and its stored size when it cannot be measured. */
const THUMB_PX = 320;
const THUMB_EST_BYTES = 25_000;
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

/** The images a pack keeps for each cache with the chosen option. */
export function imagesFor(c: PackCache, option: PackMeta["images"]): PackImage[] {
  if (option === "full") return c.images;
  if (option === "thumbs") return c.images.slice(0, 1);
  return [];
}

export interface PackEstimate {
  caches: number;
  /** The pack's data as stored. */
  dataBytes: number;
  /** Thumbnails: downloaded (the first images as published) and stored (the small copies). */
  thumbsDownload: number;
  thumbsStored: number;
  /** Every image as published. */
  fullBytes: number;
  /** Does the pack stay within the size limit with full images? */
  fullFits: boolean;
}

export function estimatePack(data: PackResponse): PackEstimate {
  const dataBytes = JSON.stringify(data.caches).length;
  let thumbsDownload = 0,
    thumbsStored = 0,
    fullBytes = 0;
  for (const c of data.caches) {
    const first = c.images[0];
    if (first) {
      thumbsDownload += first.bytes;
      thumbsStored += Math.min(first.bytes, THUMB_EST_BYTES);
    }
    for (const i of c.images) fullBytes += i.bytes;
  }
  return {
    caches: data.caches.length,
    dataBytes,
    thumbsDownload,
    thumbsStored,
    fullBytes,
    fullFits: dataBytes + fullBytes <= PACK_MAX_BYTES,
  };
}

/** A small JPEG of an image, made on the phone; the image itself when the browser cannot draw it. */
export async function thumbnail(blob: Blob): Promise<Blob> {
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return blob;
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const small = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    return small.size < blob.size ? small : blob;
  } catch {
    return blob;
  }
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
  opts: { onProgress?: (p: SaveProgress) => void; signal?: AbortSignal; shrink?: (b: Blob) => Promise<Blob> } = {},
): Promise<PackMeta> {
  const shrink = opts.shrink ?? thumbnail;
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
        const res = await fetcher(base + img.url, { signal: opts.signal });
        if (res.ok) {
          const raw = await res.blob();
          const kept = meta.images === "thumbs" ? await shrink(raw) : raw;
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
  const data = await fetchPackData(fetcher, base, meta.area, meta.filters, meta.generation);
  if (data === "unchanged") {
    const touched = { ...meta, refreshedAt: now };
    await store.touchPack(touched);
    return { meta: touched, changed: false };
  }
  return { meta: await storePack(store, fetcher, base, { ...meta, refreshedAt: now }, data, opts), changed: true };
}
