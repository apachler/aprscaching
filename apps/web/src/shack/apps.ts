// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shack app registry — the launchable "apps" the shack drawer offers. Each has a dedicated
 * symbol so it can be launched from the shack AND pinned to the left nav rail. Some apps open a
 * dedicated wide surface (terminal, BBS); the rest open the shack focused on their config group.
 */
import { useEffect, useState } from "react";
import type { IconName } from "../ui/index.js";
import { notePrefChange, PREFS_EVENT } from "../prefs.js";

export type ShackAppId = "terminal" | "bbs" | "tools" | "decoder" | "rig" | "remote" | "node";

export interface ShackApp {
  id: ShackAppId;
  icon: IconName;
  label: string;
  blurb: string;
  /** Surface header title (emoji-free) shown when the app is launched into its own workspace. */
  title: string;
  /** Modern-theme leading emoji for the title/launcher; dropped in Phosphor (emoji-free). */
  emoji: string;
  /** Wide workspace (fills the content area, hides the map) vs. a normal docked side panel. */
  wide?: boolean;
  /** Operator-only: this app drives the instance's always-on server RF infrastructure (the ingest box /
   *  its NET/ROM node), so it's shown + openable ONLY to the instance operator (sysop). Everything without
   *  this flag is browser-direct / platform functionality any web user can run — the "field station". */
  sysop?: boolean;
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
    blurb: "Graphic-Packet multi-channel connected-mode terminal (Web Serial / BLE)",
    emoji: "📻",
    title: "Packet terminal",
    wide: true,
  },
  {
    id: "bbs",
    icon: "bbs",
    label: "BBS",
    blurb: "Store-and-forward mail, bulletins & threads",
    emoji: "✉",
    title: "BBS",
    wide: true,
  },
  {
    id: "decoder",
    icon: "decode",
    label: "Packet decoder",
    blurb: "Decode a raw AX.25 / APRS frame",
    emoji: "🔎",
    title: "Packet decoder",
    wide: true,
  },
  {
    id: "tools",
    icon: "tools",
    label: "Tools",
    blurb: "Sandboxed plugins & signal decoders",
    emoji: "🧩",
    title: "Tools",
    wide: true,
  },
  {
    id: "rig",
    icon: "dial",
    label: "Rig control",
    blurb: "CAT — one-click tune (Web Serial)",
    emoji: "🎚",
    title: "Rig control (CAT)",
  },
  {
    id: "node",
    icon: "node",
    label: "NET/ROM node",
    blurb: "Run a node · digipeater · sysop console",
    emoji: "🗄",
    title: "NET/ROM node",
    wide: true,
    sysop: true,
  },
  {
    id: "remote",
    icon: "server",
    label: "Remote box",
    blurb: "Control your ingest box over the relay",
    emoji: "🛰",
    title: "Remote control — your box",
    sysop: true,
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
