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
    body: "The same caches as a list, closest first. Open one for its hint, its find code, and the verification a find there needs.",
  },
  {
    title: "Log the find at the cache",
    anchor: '[data-tour="log"]',
    when: "signed-in",
    body: "Log a find sits at the foot of a cache. Tap it at the spot with location on for a Location-verified find. Key it over APRS and, once this instance's receiving station hears you, it is Radio-verified.",
  },
  {
    title: "Explore now, sign in to play",
    when: "signed-out",
    body: "Browsing is read-only. Sign in with your callsign to log finds, hide caches, and open the Shack.",
  },
];

/**
 * The public game tour (`/tour/game`): the real app on demo data, opened on a cache. It walks the cache, the find,
 * the map, Nearby and the ranks, and ends on the way out to joining for real.
 */
export const GAME_TOUR_STEPS: TourStep[] = [
  {
    title: "This is a cache",
    anchor: '[data-tour="cache"]',
    body: "The Landhaus courtyard in Graz: how hard it is to find, how hard the walk is, and its coordinates and locator.",
  },
  {
    title: "Log the find at the cache",
    anchor: '[data-tour="log"]',
    body: "Tap Log a find at the spot for a Location-verified find. Key it over APRS, and once a trusted receiver hears you, it is Radio-verified.",
  },
  {
    title: "Every cache is on the map",
    anchor: '[data-tour="map"]',
    body: "The glyph on a marker is the cache type: a box, a multi-stage, a summit, a station on the move.",
  },
  {
    title: "Nearby sorts them by distance",
    anchor: '[data-tour="nearby"]',
    body: "The same caches as a list, closest first. Download an area and the list, the map and the compass work offline.",
  },
  {
    title: "Ranked by callsign",
    anchor: '[data-tour="ranks"]',
    body: "Leaderboards count people by their callsign, per region, and show how each find was confirmed.",
  },
  {
    title: "Your turn",
    body: "Everything here is demo data. Join with your callsign to hide caches and log finds of your own.",
    cta: { label: "Join with your callsign", href: "/join" },
  },
];

/**
 * The public Shack tour (`/tour/shack`): the real app on demo data, opened on the Shack. It walks the apps, the
 * rail, messages and the live map, and ends on the way out to joining for real.
 */
export const SHACK_TOUR_STEPS: TourStep[] = [
  {
    title: "The Shack",
    anchor: '[data-tour="shack-apps"]',
    body: "Packet terminal, BBS, tools and rig control. Each app drives a radio from this browser over USB, Bluetooth or the sound card.",
  },
  {
    title: "Always one tap away",
    anchor: '[data-tour="shack"]',
    body: "The Shack lives in the rail. Pin an app or a tool and it gets a place of its own there.",
  },
  {
    title: "Messages over APRS and MeshCom",
    anchor: '[data-tour="messages"]',
    body: "Read, send and acknowledge the messages the instance hears, with retries until the other station answers.",
  },
  {
    title: "Stations on the same map",
    anchor: '[data-tour="map"]',
    body: "Live stations, MeshCom nodes and activity spots show on the map, beside the caches.",
  },
  {
    title: "Your station, your account",
    body: "Everything here is demo data. Join with your callsign: receiving works straight away, and transmitting opens once you verify it.",
    cta: { label: "Join with your callsign", href: "/join" },
  },
];
