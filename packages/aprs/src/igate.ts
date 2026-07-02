// SPDX-License-Identifier: MIT
/**
 * igate.ts — APRS IGate decision logic (pure). An IGate bridges RF and APRS-IS both ways:
 *   RX-IGate (RF -> IS): relay frames heard on RF up to the internet, with a qAR construct.
 *   TX-IGate (IS -> RF): gate *messages* from the internet down to RF for stations heard locally.
 * The transport (KISS / APRS-IS sockets) and the "heard locally" state live in the connector; the
 * gating rules below are pure and unit-tested.
 */
import type { ParsedFrame } from "./types.js";

const NO_GATE_TOKENS = ["TCPIP", "TCPXX", "NOGATE", "RFONLY"];
const baseCall = (c: string) => c.replace(/\*$/, "").split("-")[0]!.toUpperCase();

/** Third-party traffic (already gated by someone else) — never re-gate. */
export const isThirdParty = (payload: string) => payload.startsWith("}");

/** Path carries a do-not-gate token (TCPIP/TCPXX/NOGATE/RFONLY)? */
export function pathBlocksGating(path: string[]): boolean {
  return path.some((p) => NO_GATE_TOKENS.includes(baseCall(p)));
}

/** RX-IGate: should this RF-heard frame be relayed to APRS-IS? */
export function shouldRxIgate(f: ParsedFrame, gateCall: string): boolean {
  if (!f.payload) return false;
  if (isThirdParty(f.payload)) return false;
  if (pathBlocksGating(f.path)) return false;
  if (baseCall(f.src) === baseCall(gateCall)) return false; // don't gate our own beacons
  return true;
}

/**
 * Build the APRS-IS line for an RF-heard frame: the original header + path, then `,qAR,GATECALL`,
 * then the info field. The path keeps its has-been-repeated marks as heard.
 */
export function rxIgateLine(f: ParsedFrame, gateCall: string): string {
  const via = f.path.length ? "," + f.path.join(",") : "";
  return `${f.src}>${f.dst}${via},qAR,${gateCall.toUpperCase()}:${f.payload}`;
}

/** The addressee of an APRS message (`:ADDRESSEE :text…`), trimmed, or null if not a message. */
export function messageAddressee(payload: string): string | null {
  const m = /^:(.{9}):/.exec(payload);
  return m ? m[1]!.trim().toUpperCase() : null;
}

/**
 * TX-IGate: should this APRS-IS frame be gated down to RF? Only messages addressed to a station
 * heard locally on RF recently, not blocked/own/third-party. `heardLocally` answers "have we heard
 * this callsign direct on RF lately?". Returns the addressee to gate to, or null.
 */
export function txIgateTarget(
  f: ParsedFrame, gateCall: string, heardLocally: (callsign: string) => boolean,
): string | null {
  if (isThirdParty(f.payload) || pathBlocksGating(f.path)) return null;
  if (baseCall(f.src) === baseCall(gateCall)) return null;
  const addr = messageAddressee(f.payload);
  if (!addr) return null;                       // only messages are TX-gated
  if (baseCall(addr) === baseCall(gateCall)) return null;
  if (/^(ack|rej)/i.test(f.payload.slice(11))) return null; // don't gate bare acks
  return heardLocally(addr) ? addr : null;
}
