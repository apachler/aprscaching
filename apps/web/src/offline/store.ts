// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline storage: the packs, their caches and images, and the app's small offline records (the log
 * queue), in IndexedDB — asynchronous, larger than localStorage, and readable by the service worker.
 * `OfflineStore` is the seam: the browser uses {@link idbStore}; tests use {@link memoryStore}.
 *
 * Every read tolerates a browser that evicted the data or offers no IndexedDB (a private window): it
 * comes back empty rather than failing, and the app carries on online.
 */
import type { PackArea, PackCache } from "@aprscaching/shared";

/** A pack's description; its caches and images are stored beside it. */
export interface PackMeta {
  id: string;
  name: string;
  /** The locator square; null for the automatic area last browsed, which is the map view's box. */
  area: PackArea | null;
  filters: { types: string[] };
  /** none: no images; thumbs: a small copy of each cache's first image; full: every image as published. */
  images: "none" | "thumbs" | "full";
  instance: string;
  createdAt: number;
  refreshedAt: number;
  /** The pack's generation on the instance (its ETag), for a cheap refresh. */
  generation: string;
  cacheCount: number;
  /** Bytes stored for the pack: its data and its images. */
  sizeBytes: number;
  /** The last area browsed, kept automatically; never listed with the user's own packs. */
  auto?: boolean;
}

export interface OfflineStore {
  packs(): Promise<PackMeta[]>;
  putPack(meta: PackMeta, caches: PackCache[]): Promise<void>;
  /** Update a pack's description only (a refresh that found nothing new). */
  touchPack(meta: PackMeta): Promise<void>;
  packCaches(packId: string): Promise<PackCache[]>;
  deletePack(packId: string): Promise<void>;
  putBlob(packId: string, key: string, blob: Blob): Promise<void>;
  deleteBlob(packId: string, key: string): Promise<void>;
  blob(packId: string, key: string): Promise<Blob | null>;
  /** The keys of a pack's stored blobs. */
  blobKeys(packId: string): Promise<string[]>;
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
}

// ---- IndexedDB ------------------------------------------------------------------------------------------

const DB_NAME = "acs-offline";
const DB_VERSION = 1;

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("packs", { keyPath: "id" });
      db.createObjectStore("packCaches", { keyPath: "packId" }); // one record per pack: its caches
      db.createObjectStore("blobs", { keyPath: ["packId", "key"] }).createIndex("packId", "packId");
      db.createObjectStore("kv");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e: unknown) => {
    opening = null;
    throw e;
  });
  return opening;
}

/** The browser's store. Reads come back empty when IndexedDB is unavailable; writes report the error. */
export function idbStore(): OfflineStore {
  const read = async <T>(fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    try {
      return await fn(await open());
    } catch {
      return fallback;
    }
  };
  return {
    packs: () =>
      read([], async (db) => (await req(db.transaction("packs").objectStore("packs").getAll())) as PackMeta[]),
    async putPack(meta, caches) {
      const tx = (await open()).transaction(["packs", "packCaches"], "readwrite");
      tx.objectStore("packs").put(meta);
      tx.objectStore("packCaches").put({ packId: meta.id, caches });
      await done(tx);
    },
    async touchPack(meta) {
      const tx = (await open()).transaction("packs", "readwrite");
      tx.objectStore("packs").put(meta);
      await done(tx);
    },
    packCaches: (packId) =>
      read([], async (db) => {
        const r = (await req(db.transaction("packCaches").objectStore("packCaches").get(packId))) as
          { caches: PackCache[] } | undefined;
        return r?.caches ?? [];
      }),
    async deletePack(packId) {
      const db = await open();
      const tx = db.transaction(["packs", "packCaches", "blobs"], "readwrite");
      tx.objectStore("packs").delete(packId);
      tx.objectStore("packCaches").delete(packId);
      const blobs = tx.objectStore("blobs");
      for (const k of (await req(blobs.index("packId").getAllKeys(packId))) as IDBValidKey[]) blobs.delete(k);
      await done(tx);
    },
    async putBlob(packId, key, blob) {
      const tx = (await open()).transaction("blobs", "readwrite");
      tx.objectStore("blobs").put({ packId, key, blob });
      await done(tx);
    },
    async deleteBlob(packId, key) {
      const tx = (await open()).transaction("blobs", "readwrite");
      tx.objectStore("blobs").delete([packId, key]);
      await done(tx);
    },
    blob: (packId, key) =>
      read(null, async (db) => {
        const r = (await req(db.transaction("blobs").objectStore("blobs").get([packId, key]))) as
          { blob: Blob } | undefined;
        return r?.blob ?? null;
      }),
    blobKeys: (packId) =>
      read([], async (db) =>
        (
          (await req(db.transaction("blobs").objectStore("blobs").index("packId").getAllKeys(packId))) as [
            string,
            string,
          ][]
        ).map((k) => k[1]),
      ),
    kvGet: (key) =>
      read(
        null,
        async (db) => ((await req(db.transaction("kv").objectStore("kv").get(key))) as string | undefined) ?? null,
      ),
    async kvSet(key, value) {
      const tx = (await open()).transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      await done(tx);
    },
  };
}

// ---- in memory (tests) -----------------------------------------------------------------------------------

export function memoryStore(): OfflineStore {
  const packs = new Map<string, PackMeta>();
  const caches = new Map<string, PackCache[]>();
  const blobs = new Map<string, Map<string, Blob>>();
  const kv = new Map<string, string>();
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    packs: async () => [...packs.values()].map(clone),
    putPack: async (m, c) => {
      packs.set(m.id, clone(m));
      caches.set(m.id, clone(c));
    },
    touchPack: async (m) => void packs.set(m.id, clone(m)),
    packCaches: async (id) => clone(caches.get(id) ?? []),
    deletePack: async (id) => {
      packs.delete(id);
      caches.delete(id);
      blobs.delete(id);
    },
    putBlob: async (id, k, b) => void blobs.set(id, (blobs.get(id) ?? new Map()).set(k, b)),
    deleteBlob: async (id, k) => void blobs.get(id)?.delete(k),
    blob: async (id, k) => blobs.get(id)?.get(k) ?? null,
    blobKeys: async (id) => [...(blobs.get(id)?.keys() ?? [])],
    kvGet: async (k) => kv.get(k) ?? null,
    kvSet: async (k, v) => void kv.set(k, v),
  };
}

/** The app's store: IndexedDB in the browser. */
let shared: OfflineStore | null = null;
export const offlineStore = (): OfflineStore => (shared ??= idbStore());
