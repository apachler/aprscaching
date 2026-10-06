// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * toolIcons.ts — the icon a tool shows where it is pinned (the rail, the More sheet) and on its row in Tools. The
 * project registry's tools have their own, by name; any other tool shows the plug.
 */
import type { IconName } from "../ui/Icon.js";

const PROJECT_ICONS: Readonly<Record<string, IconName>> = {
  "packet-decoder": "decode",
  "digimode-decoders": "signal",
  sevenplus: "attach",
  "monitor-colouriser": "filter",
  "ctext-macros": "copy",
  "auto-responder": "message",
  "beacon-scheduler": "antenna",
  "aprs-ssid-guide": "info",
  "watch-alert": "alert",
  mheard: "radio",
  "auto-status": "flag",
  "grid-bearing": "navigation",
  "unit-convert": "ruler",
  "cw-encoder": "edit",
  "station-db": "book",
  "info-responder": "menu",
  "away-note": "bookmark",
  "connect-bell": "bell",
  "link-ping": "link",
  "sched-query": "log",
  "block-art": "layers",
  "map-waypoints": "place",
};

/** The icon for a tool: the project tool's own icon, else the plug. */
export const toolIcon = (name: string): IconName => PROJECT_ICONS[name] ?? "plug";
