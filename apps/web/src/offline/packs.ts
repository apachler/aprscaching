// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline packs from the app's side: the user's packs, the automatic one for the area last browsed, and
 * reading them when the instance cannot be reached. Downloading lives in download.ts.
 *
 * While offline the map shows the caches of every pack in view, each once (a cache in several packs is
 * taken from the most recently refreshed one; the automatic area only where no pack of the user's has it),
 * and says where they came from. The cache page reads the cache's stored details, logs and images.
 */
import type { MapCache, PackCache } from "@aprscaching/shared";
import type { OfflineStore, PackMeta } from "./store.js";

export const AUTO_PACK_ID = "auto";
/** The automatic area keeps at most this many caches. */
const AUTO_MAX = 2000;

type BBox = [number, number, number, number];
const inBox = (b: BBox, lat: number | null, lon: number | null) =>
  lat != null && lon != null && lat >= b[1] && lat <= b[3] && lon >= b[0] && lon <= b[2];

/** A map cache as the automatic area stores it: no details beyond the map's. */
const bare = (c: MapCache): PackCache => ({
  ...c,
  stationCall: null,
  minTrust: null,
  fedScope: "public",
  driveIn: false,
  country: null,
  tags: [],
  sourceOwner: null,
  sourceAttribution: null,
  externalId: null,
  hint: null,
  description: null,
  createdAt: null,
  updatedAt: null,
  stages: [],
  logs: [],
  images: [],
});

/** Keep the caches of the area just browsed as the automatic pack, so the map has them offline. */
export async function saveAutoArea(store: OfflineStore, caches: MapCache[], instance: string, now: number) {
  const kept = caches.slice(0, AUTO_MAX).map(bare);
  const meta: PackMeta = {
    id: AUTO_PACK_ID,
    name: "the area you last browsed",
    area: null,
    filters: { types: [] },
    images: "none",
    instance,
    createdAt: now,
    refreshedAt: now,
    generation: "",
    cacheCount: kept.length,
    sizeBytes: JSON.stringify(kept).length,
    auto: true,
  };
  await store.putPack(meta, kept);
}

/** Where the offline map's caches came from: the pack with most of them. */
export interface OfflineSource {
  name: string;
  refreshedAt: number;
  auto: boolean;
  /** How many packs contributed. */
  packs: number;
}

/** The caches of every pack inside the box, each once, and where they came from. */
export async function packCachesInBox(
  store: OfflineStore,
  bbox: BBox,
): Promise<{ caches: MapCache[]; source: OfflineSource | null }> {
  // the user's packs first, newest first; the automatic area last
  const packs = (await store.packs()).sort(
    (a, b) => Number(!!a.auto) - Number(!!b.auto) || b.refreshedAt - a.refreshedAt,
  );
  const seen = new Map<string, MapCache>();
  const from = new Map<string, number>();
  for (const p of packs) {
    let n = 0;
    for (const c of await store.packCaches(p.id)) {
      if (!inBox(bbox, c.lat, c.lon) || seen.has(c.globalId)) continue;
      seen.set(c.globalId, mapFields(c));
      n++;
    }
    if (n) from.set(p.id, n);
  }
  if (!seen.size) return { caches: [], source: null };
  const top = packs.filter((p) => from.has(p.id)).sort((a, b) => from.get(b.id)! - from.get(a.id)!)[0]!;
  return {
    caches: [...seen.values()],
    source: { name: top.name, refreshedAt: top.refreshedAt, auto: !!top.auto, packs: from.size },
  };
}

function mapFields(c: PackCache): MapCache {
  return {
    globalId: c.globalId,
    id: c.id,
    code: c.code,
    ownerCall: c.ownerCall,
    title: c.title,
    type: c.type,
    status: c.status,
    difficulty: c.difficulty,
    terrain: c.terrain,
    lat: c.lat,
    lon: c.lon,
    origin: c.origin,
    mirrored: c.mirrored,
    originTrust: c.originTrust,
    source: c.source,
    sourceName: c.sourceName,
    sourceUrl: c.sourceUrl,
    country: c.country,
    tags: c.tags,
  };
}

/** A native cache by its id, from the most recently refreshed pack that holds its details. */
export async function packCache(store: OfflineStore, id: number): Promise<{ cache: PackCache; pack: PackMeta } | null> {
  const packs = (await store.packs()).sort(
    (a, b) => Number(!!a.auto) - Number(!!b.auto) || b.refreshedAt - a.refreshedAt,
  );
  for (const p of packs) {
    const c = (await store.packCaches(p.id)).find((x) => x.id === id);
    if (c) return { cache: c, pack: p };
  }
  return null;
}

/** The user's own packs, newest first (the automatic area is not one of them). */
export async function userPacks(store: OfflineStore): Promise<PackMeta[]> {
  return (await store.packs()).filter((p) => !p.auto).sort((a, b) => b.createdAt - a.createdAt);
}
