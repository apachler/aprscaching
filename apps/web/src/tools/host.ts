/**
 * host.ts (web) — the ONE shared ToolHost for the whole app. Tools are enabled once (in the Tools app)
 * and their contributions then reach every surface that consults the host — the packet terminal, BBS,
 * the NET/ROM node, and the Tools console — filtered by each tool's declared `surfaces` (docs/28). A
 * module singleton (not per-panel) is what makes a plugin work beyond the packet terminal.
 */
import { useEffect, useReducer } from "react";
import { ToolHost, builtinTools } from "@aprsweb/tools";

// TX gate (H5): a module flag the app keeps in sync with the signed-in session's verified state, so a
// tool's scheduleBeacon/requestTx is allowed only for a verified callsign — exactly as before, just
// shared. Set from Platform on session change (setToolTxVerified).
let txVerified = false;
export function setToolTxVerified(v: boolean): void { txVerified = v; }

const CHANGED = "acs:tools-changed";           // fired when a tool is enabled/disabled → surfaces re-read
export const TOOLS_TOAST_EVENT = "acs:tools-toast"; // beacon/TX feedback for whatever surface wants to show it
const toast = (msg: string) => { try { window.dispatchEvent(new CustomEvent(TOOLS_TOAST_EVENT, { detail: msg })); } catch { /* SSR */ } };

/** The single shared host. Built-ins are registered once; all OFF by default. */
export const toolHost = new ToolHost({
  txGate: () => txVerified,
  onLog: (t, m) => console.log(`[tool:${t}]`, m),
  onBeacon: (t, s) => toast(`${t}: beacon every ${Math.round(s.intervalSec / 60)}min (TX-gated)`),
  transmit: (t, info) => toast(`${t} TX: ${info}`),
});
for (const t of builtinTools()) { try { toolHost.register(t); } catch { /* already registered (HMR) */ } }

// Drive the periodic on_tick event (docs/28 B) so timer tools (auto-status, watchdogs) fire. Cheap:
// dispatch is a no-op unless a tool hooked on_tick. Once per module load.
if (typeof window !== "undefined") setInterval(() => toolHost.dispatch("on_tick", {}), 60_000);

/** Enable/disable a tool and notify every mounted surface to re-read the host. */
export function setToolEnabled(name: string, on: boolean): { ok: boolean; error?: string } {
  const r = toolHost.setEnabled(name, on);
  try { window.dispatchEvent(new Event(CHANGED)); } catch { /* SSR */ }
  return r;
}

/** Subscribe a component to tool enable/disable changes so it re-renders with the current contributions. */
export function useToolHost(): ToolHost {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const h = () => force();
    window.addEventListener(CHANGED, h);
    return () => window.removeEventListener(CHANGED, h);
  }, []);
  return toolHost;
}
