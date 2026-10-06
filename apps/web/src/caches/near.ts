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
const NEAR_M = 150;
/** A reading less sure than this cannot say you are within the radius. */
const NEAR_MAX_ACCURACY_M = 100;

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

/**
 * May a prompt from the radio's beacon show? Not for a cache the player settled (found, did-not-find, hid) or
 * dismissed, nor for one the map knows is no longer active (archived, disabled or removed). Pure.
 */
export function promptAllowed(p: GeofencePrompt, caches: MapCache[], quiet: ReadonlySet<number>): boolean {
  if (quiet.has(p.cacheId)) return false;
  const known = caches.find((c) => c.id === p.cacheId);
  return !known || known.status === "active";
}

const DISMISSED_KEY = "acs.near.dismissed";

/** The caches whose prompt the player dismissed in this browser session; empty where storage is unavailable. */
export function loadDismissed(): Set<number> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : []);
  } catch {
    return new Set();
  }
}

/** Remember a dismissed prompt for the rest of the session, across reloads. */
export function saveDismissed(ids: ReadonlySet<number>): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* private mode or blocked storage: the dismissal holds until the page reloads */
  }
}
