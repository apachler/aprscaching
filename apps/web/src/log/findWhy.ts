// SPDX-License-Identifier: AGPL-3.0-or-later
import { UNVERIFIED_CALL_REASON } from "@aprscaching/shared";
import type { LogResult } from "../api.js";
import type { Formatters } from "../format.js";
import { TIER_NAME } from "../ui/Badge.js";

/** What placed (or failed to place) the finder at the cache, in words, for the result card. */
export function findWhy(r: LogResult, fmt: Formatters, geoAwayM: number | null, hadGeo: boolean): string {
  const d = r.distanceM != null ? fmt.distance(r.distanceM) : null;
  if (r.verified) {
    if (r.tier === "A")
      return `A receiving station heard your transmission on the air at the cache${
        r.corroboratedBy ? `, confirmed by ${r.corroboratedBy}` : ""
      }.`;
    if (r.tier === "B")
      return `Your device was ${d ?? "at the cache"}${d ? " from the cache" : ""} when you logged it.`;
    return "This cache counts every logged find.";
  }
  const needs = /requires tier ([ABC])/.exec(r.reason ?? "")?.[1] as "A" | "B" | "C" | undefined;
  if (needs && r.tier)
    return `This cache needs a ${TIER_NAME[needs]} find. Yours was ${TIER_NAME[r.tier]}, so it is on record but does not count as verified.`;
  if (r.reason === UNVERIFIED_CALL_REASON)
    return "A receiving station heard your callsign on the air at the cache, but the callsign is not verified yet, so it cannot make the find Radio-verified. Verify your callsign to count finds like this.";
  if (r.method === "aprs_is")
    return "Only an internet (APRS-IS) position placed you here. Anyone can send one, so it cannot verify a find.";
  if (geoAwayM != null) return `Your device was ${fmt.distance(geoAwayM)} from the cache — too far to verify the find.`;
  if (!hadGeo)
    return "Your location was not available and no receiving station heard you here. Allow location access and log at the cache to verify a find.";
  return "Nothing placed you at the cache when you logged it.";
}
