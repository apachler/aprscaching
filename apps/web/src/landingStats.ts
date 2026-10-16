// SPDX-License-Identifier: AGPL-3.0-or-later
/** The instance's counts on the landing page, from the read API's `/api/v1/stats`. */
export interface Stats {
  caches: number;
  findsOnAirThisWeek: number;
  stationsHeardLastHour: number;
}

/**
 * Each count shows once it is large enough to say something: a new instance with three caches reads as an empty
 * room. Below its floor a count is left out; the numbers shown are always the instance's own.
 */
export const STAT_FLOOR: Record<keyof Stats, number> = {
  caches: 25,
  findsOnAirThisWeek: 10,
  stationsHeardLastHour: 25,
};

const ORDER: (keyof Stats)[] = ["caches", "findsOnAirThisWeek", "stationsHeardLastHour"];

/** The counts worth showing, in their fixed order. */
export function statsShown(stats: Stats): [keyof Stats, number][] {
  return ORDER.filter((k) => typeof stats[k] === "number" && stats[k] >= STAT_FLOOR[k]).map((k) => [k, stats[k]]);
}
