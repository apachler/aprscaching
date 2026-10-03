// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The "you're near" check on the device: the phone's own reading against the caches the map has loaded. It runs
 * here, never on the gateway, so the phone's location stays on the phone; the gateway's prompt from a radio's
 * APRS position is the other source of the same banner.
 */
import type { GeofencePrompt } from "@aprscaching/shared";
import type { MapCache } from "../api.js";
import { haversine } from "../map/geo.js";

/** The radius the gateway's prompt from a radio beacon uses too. */
export const NEAR_M = 150;
/** A reading less sure than this cannot say you are within the radius. */
export const NEAR_MAX_ACCURACY_M = 100;

const baseOf = (c: string) => c.toUpperCase().split("-")[0] ?? "";

/**
 * The nearest cache within `NEAR_M` of a reading that a player could log here: an active cache of this instance
 * (a mirror has no local id) that is not their own and not in `skip`. Null when there is none. Pure.
 */
export function nearestLoggable(
  caches: MapCache[],
  at: { lat: number; lon: number; accuracyM: number },
  callsign: string,
  skip: ReadonlySet<number>,
): GeofencePrompt | null {
  if (at.accuracyM > NEAR_MAX_ACCURACY_M) return null;
  const me = baseOf(callsign);
  let best: GeofencePrompt | null = null;
  for (const c of caches) {
    if (c.id == null || c.lat == null || c.lon == null || c.status !== "active" || skip.has(c.id)) continue;
    if (me && baseOf(c.ownerCall) === me) continue;
    const d = haversine(at.lat, at.lon, c.lat, c.lon);
    if (d <= NEAR_M && (!best || d < best.distanceM))
      best = { type: "near_cache", cacheId: c.id, code: c.code, title: c.title, distanceM: Math.round(d) };
  }
  return best;
}
