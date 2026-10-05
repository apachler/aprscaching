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

export type ShackAppId = "terminal" | "bbs" | "tools" | "decoder" | "rig" | "remote" | "node";

/** What a launched app receives; each app takes the subset it needs. */
export interface ShackAppProps {
  callsign: string;
  verified: boolean;
  map: maplibregl.Map | null;
  onClose: () => void;
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

// Every shack app opens its OWN surface (terminal/BBS/tools/decoder/node are wide workspaces;
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
    id: "decoder",
    icon: "decode",
    label: "Packet decoder",
    blurb: "Paste a raw APRS line and see every field it carries",
    title: "Packet decoder",
    wide: true,
    load: () => import("./DecoderPanel.js").then((m) => ({ default: m.DecoderPanel })),
  },
  {
    id: "tools",
    icon: "tools",
    label: "Tools",
    blurb: "Plugins and signal decoders that run sandboxed in this browser",
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

const PIN_KEY = "acs.pins";
const DEFAULT_PINS: ShackAppId[] = []; // nothing pinned by default — the user pins what they use
const readPins = (): ShackAppId[] => {
  try {
    const stored = localStorage.getItem(PIN_KEY);
    if (stored == null) return DEFAULT_PINS; // never set → sensible default
    const raw = JSON.parse(stored);
    return Array.isArray(raw) ? raw.filter((x): x is ShackAppId => SHACK_APPS.some((a) => a.id === x)) : [];
  } catch {
    return DEFAULT_PINS;
  }
};

/** Pinned-app ids (persisted in localStorage) + a toggle. Pinned apps show in the nav rail. */
export function usePinnedApps(): {
  pins: ShackAppId[];
  toggle: (id: ShackAppId) => void;
  isPinned: (id: ShackAppId) => boolean;
} {
  const [pins, setPins] = useState<ShackAppId[]>(readPins);
  // Re-read when an account sign-in pulls prefs and rewrites acs.pins (multi-device sync).
  useEffect(() => {
    const onSync = () => setPins(readPins());
    window.addEventListener(PREFS_EVENT, onSync);
    return () => window.removeEventListener(PREFS_EVENT, onSync);
  }, []);
  const toggle = (id: ShackAppId) =>
    setPins((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      notePrefChange(); // mirror to the account (if signed in)
      return next;
    });
  return { pins, toggle, isPinned: (id) => pins.includes(id) };
}
