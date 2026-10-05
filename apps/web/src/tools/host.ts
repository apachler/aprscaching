// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * host.ts (web) — the ONE shared ToolHost for the whole app. Tools are enabled once (in the Tools app)
 * and their contributions then reach every surface that consults the host — the packet terminal, BBS,
 * the NET/ROM node, and the Tools console — filtered by each tool's declared `surfaces`. A
 * module singleton (not per-panel) is what makes a plugin work beyond the packet terminal.
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import { ToolHost, builtinTools, type ToolManifest } from "@aprscaching/tools";
import type { Sandbox } from "./sandbox.js";
import { TOAST_EVENT } from "../ui/Toast.js";

// TX gate: a module flag the app keeps in sync with the signed-in session's verified state, so a
// tool's scheduleBeacon/requestTx is allowed only for a verified callsign — real on-air keying
// requires a verified callsign. Set from Platform on session change (setToolTxVerified).
let txVerified = false;
export function setToolTxVerified(v: boolean): void {
  txVerified = v;
}

const CHANGED = "acs:tools-changed"; // a tool was enabled/disabled or replaced its panel/layer → surfaces re-read
// beacon/TX feedback: the app-wide toast provider shows it whichever surface is open
const toast = (msg: string) => {
  try {
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: msg }));
  } catch {
    /* SSR */
  }
};

let changePending = false;

/** The single shared host. Built-ins are registered once; all OFF by default. */
export const toolHost = new ToolHost({
  txGate: () => txVerified,
  onLog: (t, m) => console.log(`[tool:${t}]`, m),
  onBeacon: (t, s) => toast(`${t}: beacon every ${Math.round(s.intervalSec / 60)}min (TX-gated)`),
  transmit: (t, info) => toast(`${t} TX: ${info}`),
  // A burst of panel/layer updates (a frame that several tools react to) coalesces into one re-read.
  onChange: () => {
    if (changePending) return;
    changePending = true;
    setTimeout(() => {
      changePending = false;
      notifyToolsChanged();
    }, 0);
  },
});
for (const t of builtinTools()) {
  try {
    toolHost.register(t);
  } catch {
    /* already registered (HMR) */
  }
}

// Drive the periodic on_tick event so timer tools (auto-status, watchdogs) fire. Cheap:
// dispatch is a no-op unless a tool hooked on_tick. Once per module load.
if (typeof window !== "undefined") setInterval(() => toolHost.dispatch("on_tick", {}), 60_000);

/**
 * Feed a heard callsign into the tool host from ANY source — the packet terminal
 * (RF/TNC), the live APRS layer, or a future feeder. Dispatches `on_frame` so mheard/watch-alert record
 * it regardless of which surface is on screen. `source` is a short provenance label ("RF", "APRS", …).
 */
export function feedHeard(call: string, source: string): void {
  if (call && call.length >= 3) toolHost.dispatch("on_frame", { peerCall: call, source });
}

/** Enable/disable a tool and notify every mounted surface to re-read the host. */
export function setToolEnabled(name: string, on: boolean): { ok: boolean; error?: string } {
  const r = toolHost.setEnabled(name, on);
  notifyToolsChanged();
  return r;
}

/** Tell every mounted surface to re-read the host (e.g. after an imported tool pushes a new panel). */
export function notifyToolsChanged(): void {
  try {
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* SSR */
  }
}

/** Call `cb` whenever the host's contributions change; returns the unsubscribe function. */
export function onToolsChanged(cb: () => void): () => void {
  window.addEventListener(CHANGED, cb);
  return () => window.removeEventListener(CHANGED, cb);
}

/** Subscribe a component to tool changes so it re-renders with the current contributions. */
export function useToolHost(): ToolHost {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => onToolsChanged(force), []);
  return toolHost;
}

// ---- imported tools: kept here, beside the host, so they outlive the Tools app's screen ----

/** An imported (sandboxed) tool: its manifest and the sandbox its commands and decoders run in. */
export interface ImportedTool {
  manifest: ToolManifest;
  sandbox: Sandbox;
}
const imported = new Map<string, ImportedTool>();

/** Record an imported tool (already registered in the host through its adapter). */
export function addImported(t: ImportedTool): void {
  imported.set(t.manifest.name, t);
  notifyToolsChanged();
}

/** The imported tools of this page session, oldest first. */
export function importedTools(): ImportedTool[] {
  return [...imported.values()];
}

/** Remove an imported tool: its sandbox frame closes, the host forgets it, and its name is free again. */
export function removeImported(name: string): void {
  const t = imported.get(name);
  if (!t) return;
  t.sandbox.destroy();
  imported.delete(name);
  toolHost.unregister(name);
  notifyToolsChanged();
}

/** What the rail needs to draw a pinned tool: its name, title and whether it was imported. */
export interface ToolEntry {
  name: string;
  title: string;
  imported: boolean;
}
const catalogKey = () =>
  toolHost
    .list()
    .map((t) => `${t.manifest.name}\u0001${t.manifest.title}\u0001${t.manifest.entry ? 1 : 0}`)
    .join("\u0002");

/**
 * The registered tools (built-in and imported) by name and title. The component re-renders only when that list
 * changes, not on every panel update a tool pushes, so the rail and the platform stay cheap while tools run.
 */
export function useToolCatalog(): ToolEntry[] {
  const [key, setKey] = useState(catalogKey);
  useEffect(() => onToolsChanged(() => setKey(catalogKey())), []);
  return useMemo(
    () =>
      key
        ? key.split("\u0002").map((row) => {
            const [name = "", title = "", imp] = row.split("\u0001");
            return { name, title, imported: imp === "1" };
          })
        : [],
    [key],
  );
}
