// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Quick-tour content: the find flow, map -> cache detail -> log a find, with one closing step that
 * differs by session. Each step points at a `data-tour` hook rather than a class, so restyling the
 * chrome cannot silently unanchor the tour; `apps/web/test/tour-anchors.mjs` fails the build if a
 * hook named here is missing from the app.
 *
 * A step whose hook is absent or off-screen still shows — the Tour falls back to its centred card
 * (see `Tour.tsx`). That is what the log step does on a first run, where no cache is open yet: the
 * copy still teaches the step, and the coach mark lands once a cache detail is on screen.
 */
import type { TourStep } from "./Tour.js";

export const TOUR_STEPS: TourStep[] = [
  {
    title: "Every cache is on the map",
    anchor: '[data-tour="map"]',
    body: "Markers are caches around you, and the glyph is the type. Tap one to open its detail.",
  },
  {
    title: "Nearby sorts them by distance",
    anchor: '[data-tour="nearby"]',
    body: "The same caches as a list, closest first. Open one for its hint, its find code, and the trust tier a find there can reach.",
  },
  {
    title: "Log the find at the cache",
    anchor: '[data-tour="log"]',
    when: "signed-in",
    body: "Log a find sits at the foot of a cache. Key it over APRS from the spot and independent receivers corroborate you — corroboration is what earns Tier A, not the tap.",
  },
  {
    title: "Explore now, sign in to play",
    when: "signed-out",
    body: "Browsing is read-only. Register with your callsign to log finds, hide caches, and open the Shack.",
  },
];
