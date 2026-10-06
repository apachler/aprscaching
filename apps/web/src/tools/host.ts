// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * host.ts (web) — the ONE shared ToolHost for the whole app. Tools are switched on once (in the Tools app) and their
 * contributions then reach every surface that consults the host — the packet terminal, BBS, the NET/ROM node, the
 * map and the Tools console — filtered by each tool's declared `surfaces`. A module singleton (not per-panel) is
 * what makes a tool work beyond the packet terminal. The host starts empty: every tool is installed by the player
 * from a registry or an address (installed.ts) and runs in the sandbox.
 *
 * A tool's transmit goes to the browser radio link, as the app's own features do: only with a control-verified
 * callsign, a transmit-capable radio and the consent the operator gave this tab, and every frame lands in Recent
 * transmissions and flashes the TX indicator. A tool never asks for consent itself; without a live grant its
 * transmission is held. A tool sends only APRS status and messages; the host rate-limits each tool (one a minute, six
 * an hour, beacons and session scripts included) and clamps its beacon interval.
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import { ToolHost, type BeaconSpec, type TxBudgets } from "@aprscaching/tools";
import { TOAST_EVENT } from "../ui/Toast.js";
import { radioLink } from "../rf/RadioLinkHost.js";

// TX gate: a module flag the app keeps in sync with the signed-in session's verified state, so a tool's
// scheduleBeacon/requestTx is allowed only for a verified callsign. Set from Platform on session change.
let txVerified = false;
export function setToolTxVerified(v: boolean): void {
  txVerified = v;
  checkToolBeacons();
}

/** The destination and path a tool's frame goes out with: the app's own tocall, one hop. */
const TOOL_DST = "APZACG";
const TOOL_PATH = ["WIDE1-1"];

const CHANGED = "acs:tools-changed"; // a tool was enabled/disabled or replaced its panel/layer → surfaces re-read
// beacon/TX feedback: the app-wide toast provider shows it whichever surface is open
const toast = (msg: string) => {
  try {
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: msg }));
  } catch {
    /* SSR */
  }
};

/** The gate a tool's transmission passes: a verified callsign and a live transmit grant for this tab's radio. */
export const toolTxOpen = (): boolean => txVerified && radioLink.canTransmit();

/**
 * Send one APRS information field for a tool over the radio link, under the callsign the grant covers. The host
 * checked the frame and the tool's budget already; the answer says whether the radio sent it.
 */
async function transmitFor(tool: string, info: string): Promise<boolean> {
  if (!toolTxOpen()) {
    toast(`${titleOf(tool)}: transmission held, no transmit consent for this tab`);
    return false;
  }
  try {
    await radioLink.transmit(
      { src: radioLink.txCall(), dst: TOOL_DST, path: TOOL_PATH, payload: info },
      `Tool ${titleOf(tool)}`,
    );
    return true;
  } catch (e) {
    toast(`${titleOf(tool)}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * One timer per tool with a beacon, and the callsign it was scheduled under. The first beacon goes out at once, then
 * one every interval, each drawing on the tool's transmit budget. A beacon holds only under the consent and the
 * callsign it was set under: a disconnect, an ended consent, a sign-out or another callsign or SSID ends every tool
 * beacon, and the tool must schedule it again.
 */
const beacons = new Map<string, { timer: ReturnType<typeof setInterval>; call: string; key: string }>();
function setBeacon(tool: string, spec: BeaconSpec | null): void {
  const prev = beacons.get(tool);
  if (prev) clearInterval(prev.timer);
  beacons.delete(tool);
  if (!spec) return;
  const send = () => {
    if (!toolTxOpen()) return;
    const held = toolHost.takeTx(tool);
    if (held) console.log(`[tool:${tool}]`, `beacon held: ${held}`);
    else void transmitFor(tool, `>${spec.comment}`);
  };
  const key = `${spec.intervalSec}\u0001${spec.comment}`;
  beacons.set(tool, { timer: setInterval(send, spec.intervalSec * 1000), call: radioLink.txCall(), key });
  // the same schedule set again says nothing new
  if (prev?.key !== key) toast(`${titleOf(tool)}: beacon every ${Math.round(spec.intervalSec / 60)} min`);
  send();
}

/** End every tool beacon whose consent or callsign is gone. */
export function checkToolBeacons(): void {
  const open = toolTxOpen();
  const call = radioLink.txCall();
  for (const [tool, b] of [...beacons]) {
    if (open && b.call === call) continue;
    toolHost.endBeacon(tool, open ? "the callsign changed" : "the transmit consent ended");
    toast(`${titleOf(tool)}: beacon ended; schedule it again to resume`);
  }
}
if (typeof window !== "undefined") radioLink.subscribe(checkToolBeacons);

let changePending = false;

/**
 * The tools' transmit budgets live in this tab's session storage: a reload keeps them, so it refills nothing; they
 * are per tab, as the transmit consent is.
 */
const TX_BUDGET_KEY = "acs.tools.txBudget";
const txBudgetStore = {
  load: () => {
    try {
      return JSON.parse(sessionStorage.getItem(TX_BUDGET_KEY) || "{}");
    } catch {
      return {};
    }
  },
  save: (b: TxBudgets) => {
    try {
      sessionStorage.setItem(TX_BUDGET_KEY, JSON.stringify(b));
    } catch {
      /* storage blocked */
    }
  },
};

/** The single shared host; empty until the player's installed tools start. */
export const toolHost = new ToolHost({
  txBudgetStore,
  txGate: toolTxOpen,
  onLog: (t, m) => console.log(`[tool:${t}]`, m),
  onBeacon: setBeacon,
  transmit: transmitFor,
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

const titleOf = (name: string) => toolHost.list().find((t) => t.manifest.name === name)?.manifest.title ?? name;

// Drive the periodic on_tick event so timer tools (auto-status, watchdogs) fire. Cheap:
// dispatch is a no-op unless a tool hooked on_tick. Once per module load.
if (typeof window !== "undefined") setInterval(() => toolHost.dispatch("on_tick", {}), 60_000);

/**
 * Feed a heard frame into the tool host from ANY source — the packet terminal (RF/TNC), the live APRS layer, or a
 * future feeder. Dispatches `on_frame` so tools record it whichever surface is on screen. `source` is a short
 * provenance label ("RF", "APRS", …); `frame` adds the destination and the text when the source knows them.
 */
export function feedHeard(call: string, source: string, frame: { dst?: string; text?: string } = {}): void {
  if (call && call.length >= 3) toolHost.dispatch("on_frame", { peerCall: call, source, ...frame });
}

/** Enable/disable a tool and notify every mounted surface to re-read the host. */
export function setToolEnabled(name: string, on: boolean): { ok: boolean; error?: string } {
  const r = toolHost.setEnabled(name, on);
  notifyToolsChanged();
  return r;
}

/** Tell every mounted surface to re-read the host (e.g. after a tool pushes a new panel). */
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

/** What the rail needs to draw a pinned tool: its name and title. */
export interface ToolEntry {
  name: string;
  title: string;
}
const catalogKey = () =>
  toolHost
    .list()
    .map((t) => `${t.manifest.name}\u0001${t.manifest.title}`)
    .join("\u0002");

/**
 * The running tools by name and title. The component re-renders only when that list changes, not on every panel
 * update a tool pushes, so the rail and the platform stay cheap while tools run.
 */
export function useToolCatalog(): ToolEntry[] {
  const [key, setKey] = useState(catalogKey);
  useEffect(() => onToolsChanged(() => setKey(catalogKey())), []);
  return useMemo(
    () =>
      key
        ? key.split("\u0002").map((row) => {
            const [name = "", title = ""] = row.split("\u0001");
            return { name, title };
          })
        : [],
    [key],
  );
}
