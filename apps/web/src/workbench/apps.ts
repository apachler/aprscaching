/**
 * Workbench app registry — the launchable "apps" the workbench drawer offers. Each has a dedicated
 * symbol so it can be launched from the workbench AND pinned to the left nav rail. Some apps open a
 * dedicated wide surface (terminal, BBS); the rest open the workbench focused on their config group.
 */
import { useEffect, useState } from "react";
import type { IconName } from "../ui/index.js";
import { notePrefChange, PREFS_EVENT } from "../prefs.js";

export type WorkbenchAppId = "terminal" | "bbs" | "tools" | "decoder" | "rig" | "remote";

export interface WorkbenchApp {
  id: WorkbenchAppId;
  icon: IconName;
  label: string;
  blurb: string;
  /** For non-surface apps: the WorkbenchPanel Group title to expand when launched. */
  group?: string;
}

export const WORKBENCH_APPS: WorkbenchApp[] = [
  { id: "terminal", icon: "radio", label: "Packet terminal", blurb: "Graphic-Packet multi-channel connected-mode terminal" },
  { id: "bbs", icon: "bbs", label: "BBS", blurb: "Store-and-forward mail, bulletins & threads" },
  { id: "tools", icon: "tools", label: "Tools", blurb: "Sandboxed plugins & signal decoders", group: "Tools (plugins)" },
  { id: "decoder", icon: "decode", label: "Packet decoder", blurb: "Decode a raw AX.25 / APRS frame", group: "Packet decoder" },
  { id: "rig", icon: "dial", label: "Rig control", blurb: "CAT — one-click tune (Web Serial)", group: "Rig control (CAT)" },
  { id: "remote", icon: "server", label: "Remote box", blurb: "Control your ingest box over the relay", group: "Remote control — your box" },
];

export const appById = (id: WorkbenchAppId): WorkbenchApp | undefined => WORKBENCH_APPS.find((a) => a.id === id);

const PIN_KEY = "acs.pins";
const DEFAULT_PINS: WorkbenchAppId[] = []; // nothing pinned by default — the user pins what they use
const readPins = (): WorkbenchAppId[] => {
  try {
    const stored = localStorage.getItem(PIN_KEY);
    if (stored == null) return DEFAULT_PINS;                      // never set → sensible default
    const raw = JSON.parse(stored);
    return Array.isArray(raw) ? raw.filter((x): x is WorkbenchAppId => WORKBENCH_APPS.some((a) => a.id === x)) : [];
  } catch { return DEFAULT_PINS; }
};

/** Pinned-app ids (persisted in localStorage) + a toggle. Pinned apps show in the nav rail. */
export function usePinnedApps(): { pins: WorkbenchAppId[]; toggle: (id: WorkbenchAppId) => void; isPinned: (id: WorkbenchAppId) => boolean } {
  const [pins, setPins] = useState<WorkbenchAppId[]>(readPins);
  // Re-read when an account sign-in pulls prefs and rewrites acs.pins (multi-device sync).
  useEffect(() => {
    const onSync = () => setPins(readPins());
    window.addEventListener(PREFS_EVENT, onSync);
    return () => window.removeEventListener(PREFS_EVENT, onSync);
  }, []);
  const toggle = (id: WorkbenchAppId) => setPins((prev) => {
    const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    notePrefChange();                                               // mirror to the account (if signed in)
    return next;
  });
  return { pins, toggle, isPinned: (id) => pins.includes(id) };
}
