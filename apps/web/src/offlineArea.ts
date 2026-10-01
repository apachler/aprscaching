// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * offlineArea.ts — "download this area" for off-grid caching. Persists the last-fetched map
 * caches so Nearby / the map / cache detail / Log-find all render with **no network**; the logged find
 * still queues + syncs when back online (`flushLogQueue`). `listCaches` write-throughs here on every
 * successful fetch (so browsing an area caches it) and reads back here when the network is down. Map tiles
 * are not stored: offline, the map shows the self-contained graticule (offlineBasemap.ts). localStorage keeps it simple and
 * synchronous; a few hundred lightweight map rows fit comfortably (IndexedDB is the scale-up path).
 */
import type { MapCache } from "@aprscaching/shared";
import type { BBox } from "./api.js";

const KEY = "acs.offline.caches";
export interface OfflineArea {
  at: number;
  bbox: BBox;
  caches: MapCache[];
}

export function saveArea(caches: MapCache[], bbox: BBox): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ at: Date.now(), bbox, caches: caches.slice(0, 2000) } satisfies OfflineArea),
    );
  } catch {
    /* quota / private mode */
  }
}
export function loadArea(): OfflineArea | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as OfflineArea) : null;
  } catch {
    return null;
  }
}
