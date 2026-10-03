// SPDX-License-Identifier: MIT
/**
 * MeshCom event → APRS frame, plus the transport hints the ingest stamps on it.
 *
 * The gateway decodes MeshCom traffic like any other APRS frame:
 *   - a position becomes an uncompressed `!` position;
 *   - a direct message becomes an APRS message `:ADDRESSEE:text` (MeshCom already carries the `{nnn`
 *     message number inside the text);
 *   - group and `*` text becomes an APRS user-defined packet (`{` + user id `M` + type `G`), which the
 *     decoder classifies as `other` — visible in the port monitor, kept out of the callsign message log because
 *     it is addressed to no station; {@link meshcomGroupOf} reads the group and text back out of it;
 *   - telemetry has no APRS mapping here: the firmware reports an absent sensor as `0`.
 */
import type { MeshcomEvent, MeshcomProvenance } from "./normalize.js";

export interface MeshcomAprsFrame {
  src: string;
  /** Relays after the originator. */
  path: string[];
  payload: string;
  kind: "position" | "message" | "other";
  lat?: number;
  lon?: number;
}

/** Uncompressed APRS `DDMM.mm` / `DDDMM.mm`, carrying a 60.00' rounding overflow into degrees. */
function dm(v: number, width: number): string {
  const a = Math.abs(v);
  let d = Math.floor(a);
  let cm = Math.round((a - d) * 6000);
  if (cm >= 6000) {
    d += 1;
    cm -= 6000;
  }
  return `${String(d).padStart(width, "0")}${(cm / 100).toFixed(2).padStart(5, "0")}`;
}

export function meshcomToAprs(e: MeshcomEvent): MeshcomAprsFrame | null {
  const path = e.provenance.path.slice(1);
  if (e.type === "pos") {
    const table = e.symbol?.[0] ?? "/";
    const code = e.symbol?.[1] ?? ">";
    const payload = `!${dm(e.lat, 2)}${e.lat < 0 ? "S" : "N"}${table}${dm(e.lon, 3)}${e.lon < 0 ? "W" : "E"}${code}`;
    return { src: e.src, path, payload, kind: "position", lat: e.lat, lon: e.lon };
  }
  if (e.type === "msg") {
    if (e.dstKind === "call")
      return { src: e.src, path, payload: `:${e.dst.padEnd(9, " ")}:${e.text}`, kind: "message" };
    return { src: e.src, path, payload: `{MG${e.dst}:${e.text}`, kind: "other" };
  }
  return null;
}

/** A MeshCom group message, as {@link meshcomToAprs} carries it: the group (a number, or `*` for all) and its text. */
export interface MeshcomGroupMessage {
  group: string;
  text: string;
}

/** The group message an APRS payload carries (`{MG<group>:text`), or null when it carries none. */
export function meshcomGroupOf(payload: string): MeshcomGroupMessage | null {
  const m = /^\{MG(\*|[1-9]\d{0,4}):([\s\S]*)$/.exec(payload);
  return m ? { group: m[1]!, text: m[2]! } : null;
}

export interface MeshcomTransportHint {
  heardVia: "rf" | "aprs_is";
  /** Set only on a direct RF hearing: the receiving node, which the gateway attests or not. */
  igateCall?: string;
}

/**
 * How a MeshCom frame enters the gateway's provenance derivation. Only a direct RF hearing names the
 * receiving node as its gate; the gateway then lifts it toward Tier A only if that node is on the
 * operator's attested-site list. A relayed RF frame is stored as heard on RF but with no gate, so it
 * can never be attested; a server or node-own frame is stored as internet-sourced.
 */
export function meshcomTransportHint(p: MeshcomProvenance, receiverCall?: string): MeshcomTransportHint {
  if (!p.rf) return { heardVia: "aprs_is" };
  if (p.direct && receiverCall) return { heardVia: "rf", igateCall: receiverCall.toUpperCase() };
  return { heardVia: "rf" };
}
