// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SearchHitCache, SearchHitStation } from "@aprscaching/shared";

/** Each cache and station once, in the order given: a cache by its id (or code), a station by its call. */
export function uniqueHits(hits: (SearchHitCache | SearchHitStation)[]): (SearchHitCache | SearchHitStation)[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = h.kind === "cache" ? `c:${h.id ?? h.code}` : `s:${h.callsign.toUpperCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
