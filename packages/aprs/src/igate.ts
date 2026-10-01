// SPDX-License-Identifier: MIT
/**
 * igate.ts — APRS IGate decision logic (pure). An IGate bridges RF and APRS-IS both ways:
 *   RX-IGate (RF -> IS): relay frames heard on RF up to the internet, with a qAR construct.
 *   TX-IGate (IS -> RF): gate *messages* from the internet down to RF for stations heard locally.
 * The transport (KISS / APRS-IS sockets) and the "heard locally" state live in the connector; the
 * gating rules below are pure and unit-tested.
 */
import { baseCall } from "./callsign.js";
import type { ParsedFrame } from "./types.js";

// RF -> IS: `TCPIP` marks a frame that already came from APRS-IS, so it is never sent back up.
const NO_GATE_TOKENS = ["TCPIP", "TCPXX", "NOGATE", "RFONLY"];
// IS -> RF: `TCPIP*` is the ordinary path of every message an APRS-IS client sends, so only the
// explicit do-not-gate tokens block it.
const NO_TX_GATE_TOKENS = ["TCPXX", "NOGATE", "RFONLY"];

/** Third-party traffic (already gated by someone else) — never re-gate. */
export const isThirdParty = (payload: string) => payload.startsWith("}");

/** Path carries a token that keeps an RF frame off APRS-IS (TCPIP/TCPXX/NOGATE/RFONLY)? */
export function pathBlocksGating(path: string[]): boolean {
  return path.some((p) => NO_GATE_TOKENS.includes(baseCall(p)));
}

/** Path carries a token that keeps an APRS-IS frame off RF (TCPXX/NOGATE/RFONLY)? */
export function pathBlocksTxGating(path: string[]): boolean {
  return path.some((p) => NO_TX_GATE_TOKENS.includes(baseCall(p)));
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
 * TX-IGate: should this APRS-IS frame be gated down to RF? Only messages (acks and rejects included,
 * since an RF station retries until its ack arrives) addressed to a station heard locally on RF
 * recently, from a sender that is not itself heard locally (the two then reach each other direct),
 * and not blocked, own or third-party. `heardLocally` answers "have we heard this callsign on RF
 * lately?". Returns the addressee to gate to, or null.
 */
export function txIgateTarget(
  f: ParsedFrame,
  gateCall: string,
  heardLocally: (callsign: string) => boolean,
): string | null {
  if (isThirdParty(f.payload) || pathBlocksTxGating(f.path)) return null;
  if (baseCall(f.src) === baseCall(gateCall)) return null;
  const addr = messageAddressee(f.payload);
  if (!addr) return null; // only messages are TX-gated
  if (baseCall(addr) === baseCall(gateCall)) return null;
  if (heardLocally(f.src)) return null;
  return heardLocally(addr) ? addr : null;
}

/**
 * The RF frame a TX-IGate transmits for an APRS-IS message: sent under the IGate's own call, with the
 * original packet carried in third-party format, `}SRC>DST,TCPIP,GATECALL*:<info>`, so the station
 * identifies as itself on air and receivers still see who wrote the message.
 */
export function txIgateFrame(
  f: ParsedFrame,
  gateCall: string,
  opts: { tocall?: string; path?: string[] } = {},
): { src: string; dst: string; path: string[]; payload: string } {
  const gate = gateCall.toUpperCase();
  return {
    src: gate,
    dst: (opts.tocall ?? "APZACG").toUpperCase(),
    path: opts.path ?? [],
    payload: `}${f.src}>${f.dst},TCPIP,${gate}*:${f.payload}`,
  };
}
