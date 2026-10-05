// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shack app registry — the launchable "apps" the shack drawer offers. Each has a dedicated
 * symbol so it can be launched from the shack AND pinned to the left nav rail, and each loads its
 * code on first launch (`load`), so none of it weighs on the platform chunk.
 */
import { useEffect, useState, type ComponentType } from "react";
import type * as maplibregl from "maplibre-gl";
import type { IconName } from "../ui/index.js";
import { notePrefChange, PREFS_EVENT } from "../prefs.js";

export type ShackAppId = "terminal" | "bbs" | "tools" | "rig" | "remote" | "node";

/** What a launched app receives; each app takes the subset it needs. */
export interface ShackAppProps {
  callsign: string;
  verified: boolean;
  map: maplibregl.Map | null;
  onClose: () => void;
  /** A built-in tool to open on launch (the Tools app reads it; `?view=tools&tool=…`). */
  tool?: string;
}

export interface ShackApp {
  id: ShackAppId;
  icon: IconName;
  label: string;
  blurb: string;
  /** Surface header title (emoji-free) shown when the app is launched into its own workspace. */
  title: string;
  /** Wide workspace (fills the content area, hides the map) vs. a normal docked side panel. */
  wide?: boolean;
  /** Operator-only: this app drives the instance's always-on server RF infrastructure (the ingest box /
   *  its NET/ROM node), so it's shown + openable ONLY to the instance operator (sysop). Everything without
   *  this flag is browser-direct / platform functionality any web user can run — the "field station". */
  sysop?: boolean;
  /** The app brings its own Panel chrome; otherwise the surface wraps it in one titled from here. */
  ownChrome?: boolean;
  /** One muted line shown above the app inside its Panel. */
  intro?: string;
  /** Load the app's component (a separate chunk, fetched on first launch). */
  load: () => Promise<{ default: ComponentType<ShackAppProps> }>;
}

// Every shack app opens its OWN surface (terminal/BBS/tools/node are wide workspaces;
// rig/remote are compact docked panels). Order = launcher order.
//
// FIELD STATION vs OPERATOR: apps without `sysop` are the web user's own *field station* — they drive
// LOCAL hardware straight from the browser (Web Serial / Web Bluetooth / Web Audio) or are pure platform
// functionality, so a solo op with just a laptop + radio can operate off-grid with no server box. The
// `sysop` apps (NET/ROM node, remote box) administer the instance's always-on server ingest — operator-only.
export const SHACK_APPS: ShackApp[] = [
  {
    id: "terminal",
    icon: "radio",
    label: "Packet terminal",
    blurb: "Connect to packet stations, BBSes and nodes through your KISS TNC, several channels at once",
    title: "Packet terminal",
    wide: true,
    ownChrome: true,
    load: () => import("../packet/TerminalPanel.js").then((m) => ({ default: m.TerminalPanel })),
  },
  {
    id: "bbs",
    icon: "bbs",
    label: "BBS",
    blurb: "Read and write packet mail and bulletins on this instance's BBS",
    title: "BBS",
    wide: true,
    ownChrome: true,
    load: () => import("../live/BbsPanel.js").then((m) => ({ default: m.BbsPanel })),
  },
  {
    id: "tools",
    icon: "plug",
    label: "Tools",
    blurb: "Built-in tools and plugins: the packet decoder, CW and PSK31 by ear, macros and more",
    title: "Tools",
    wide: true,
    load: () => import("../tools/ToolsPanel.js").then((m) => ({ default: m.ToolsPanel })),
  },
  {
    id: "rig",
    icon: "dial",
    label: "Rig control",
    blurb: "Tune your radio over its CAT port with one click",
    title: "Rig control (CAT)",
    intro:
      "Tune your transceiver over Web Serial — the APRS frequency, a manual MHz, or a live spot's freq. Tuning only (no transmit).",
    load: () => import("./RigControl.js").then((m) => ({ default: m.RigControl })),
  },
  {
    id: "node",
    icon: "node",
    label: "NET/ROM node",
    blurb: "Read-only view of this instance's NET/ROM node: the nodes it learned and the stations it heard",
    title: "NET/ROM node",
    wide: true,
    sysop: true,
    intro:
      "The NODES table this instance's node learned and its MHeard list, read-only. The node runs on the instance's ingest box and answers the node commands on the air; the packet terminal connects to it.",
    load: () => import("./NodePanel.js").then((m) => ({ default: m.NodePanel })),
  },
  {
    id: "remote",
    icon: "server",
    label: "Remote box",
    blurb: "Send commands to your ingest box from here, with no port forward",
    title: "Remote control — your box",
    sysop: true,
    load: () => import("./RemoteControl.js").then((m) => ({ default: m.RemoteControl })),
  },
];

export const appById = (id: ShackAppId): ShackApp | undefined => SHACK_APPS.find((a) => a.id === id);

/**
 * A pin on the nav rail: a Shack app by its id, or a tool (built-in or imported) as `tool:<name>`. A pinned tool
 * opens the Tools app with that tool open.
 */
export type ToolPin = `tool:${string}`;
export type PinId = ShackAppId | ToolPin;
const TOOL_NAME = /^[a-z0-9-]{2,40}$/; // a tool manifest's name rule
export const toolPin = (name: string): ToolPin => `tool:${name}`;
/** The tool a pin names, or null for an app pin. */
export const pinnedTool = (pin: string): string | null => (pin.startsWith("tool:") ? pin.slice(5) : null);

const PIN_KEY = "acs.pins";
const PINS_EVENT = "acs:pins-changed"; // one hook instance changed the pins; the others re-read them
const DEFAULT_PINS: PinId[] = []; // nothing pinned by default — the user pins what they use

/**
 * The stored pin list, cleaned: ids that name no app and no valid tool name drop, and duplicates go. Order is kept,
 * so the rail keeps the user's order.
 */
export function normalizePins(raw: unknown): PinId[] {
  if (!Array.isArray(raw)) return [];
  const out: PinId[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const tool = pinnedTool(x);
    const ok = tool != null ? TOOL_NAME.test(tool) : SHACK_APPS.some((a) => a.id === x);
    if (ok && !out.includes(x as PinId)) out.push(x as PinId);
  }
  return out;
}

/** `pins` with `id` added at the end, or taken out when it is there. */
export const togglePinIn = (pins: readonly PinId[], id: PinId): PinId[] =>
  pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];

const readPins = (): PinId[] => {
  try {
    const stored = localStorage.getItem(PIN_KEY);
    if (stored == null) return DEFAULT_PINS; // never set → sensible default
    return normalizePins(JSON.parse(stored));
  } catch {
    return DEFAULT_PINS;
  }
};
function writePins(next: PinId[]): void {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  notePrefChange(); // mirror to the account (if signed in)
  try {
    window.dispatchEvent(new Event(PINS_EVENT));
  } catch {
    /* SSR */
  }
}

/** Take a pin off the rail (a removed or switched-off imported tool); a no-op when it is not pinned. */
export function unpin(id: PinId): void {
  const pins = readPins();
  if (pins.includes(id)) writePins(pins.filter((x) => x !== id));
}

/** The pins (persisted in localStorage, synced to the account) + a toggle. Pinned apps and tools show on the rail. */
export function usePins(): {
  pins: PinId[];
  toggle: (id: PinId) => void;
} {
  const [pins, setPins] = useState<PinId[]>(readPins);
  // Re-read when another surface changes a pin, or an account sign-in pulls prefs and rewrites acs.pins.
  useEffect(() => {
    const onSync = () => setPins(readPins());
    window.addEventListener(PREFS_EVENT, onSync);
    window.addEventListener(PINS_EVENT, onSync);
    return () => {
      window.removeEventListener(PREFS_EVENT, onSync);
      window.removeEventListener(PINS_EVENT, onSync);
    };
  }, []);
  const toggle = (id: PinId) => writePins(togglePinIn(readPins(), id));
  return { pins, toggle };
}
