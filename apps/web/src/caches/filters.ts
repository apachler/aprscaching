// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CacheType, MapCache } from "@aprscaching/shared";

/** The map's cache filters: types and tags match any selected one; an empty country matches every country. */
export interface CacheFilters {
  types: CacheType[];
  q: string;
  country: string;
  tags: string[];
}
export const NO_FILTERS: CacheFilters = { types: [], q: "", country: "", tags: [] };
/** Is any cache filter set? */
export const filtering = (f: CacheFilters) => f.types.length > 0 || f.q.length > 0 || !!f.country || f.tags.length > 0;

/** Does a cache pass the filters? A tag or country filter passes only caches that carry one. */
export function passes(c: MapCache, f: CacheFilters): boolean {
  if (f.types.length > 0 && !f.types.includes(c.type)) return false;
  if (f.q && !`${c.code} ${c.title ?? ""}`.toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.country && (c.country ?? "").trim().toLowerCase() !== f.country.toLowerCase()) return false;
  if (f.tags.length > 0 && !(c.tags ?? []).some((t) => f.tags.includes(t))) return false;
  return true;
}

/** The countries and the most used tags among the loaded caches, for the filter's choices. */
export function facetsOf(caches: MapCache[], maxTags = 24): { countries: string[]; tags: string[] } {
  const countries = new Map<string, string>();
  const tags = new Map<string, number>();
  for (const c of caches) {
    const country = c.country?.trim();
    if (country && !countries.has(country.toLowerCase())) countries.set(country.toLowerCase(), country);
    for (const t of c.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  return {
    countries: [...countries.values()].sort((a, b) => a.localeCompare(b)),
    tags: [...tags.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxTags)
      .map(([t]) => t),
  };
}
