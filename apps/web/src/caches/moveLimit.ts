// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The owner's view of the move rule: a cache moves freely until its first find, then each of its coordinates at
 * most `limitM` from where it was found. The gateway enforces it; the edit form measures a move as it is typed,
 * so the owner sees the distance before saving. Pure.
 */
import { haversine } from "../map/geo.js";

export interface Point {
  lat: number;
  lon: number;
}

/** How a typed place measures against a pin: the distance, and whether it is beyond the limit. */
interface MoveCheck {
  distanceM: number;
  over: boolean;
}

/** Measure `to` from `pin`; null when nothing is pinned or no place is typed. */
export function checkMove(limitM: number, pin: Point | null | undefined, to: Point | null): MoveCheck | null {
  if (!pin || !to) return null;
  const distanceM = haversine(pin.lat, pin.lon, to.lat, to.lon);
  return { distanceM, over: distanceM > limitM };
}

/** The one line the form shows beside a coordinate. */
export function moveLine(limitM: number, pin: Point | null | undefined, check: MoveCheck | null): string {
  if (!pin) return "No finds yet, so it moves freely.";
  const rule =
    limitM === 0 ? "Found already, so it stays where it was found." : `Found already: it moves at most ${limitM} m.`;
  if (!check) return rule;
  const d = `${Math.round(check.distanceM)} m from where it was found`;
  return check.over
    ? `${d}: beyond the ${limitM} m limit. Archive the cache and hide a new one to move it further.`
    : `${d} (limit ${limitM} m).`;
}
