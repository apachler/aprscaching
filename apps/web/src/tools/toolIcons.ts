// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * toolIcons.ts — the icon a tool shows where it is pinned (the rail, the More sheet) and on its row in Tools. A
 * built-in tool has its own; an imported tool, and any tool without one here, shows the plug.
 */
import type { IconName } from "../ui/Icon.js";

const BUILTIN_ICONS: Readonly<Record<string, IconName>> = {
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

/** The icon for a tool: its built-in icon, else the plug (every imported tool). */
export const toolIcon = (name: string, imported: boolean): IconName => (!imported && BUILTIN_ICONS[name]) || "plug";
