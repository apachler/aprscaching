// SPDX-License-Identifier: MIT
/**
 * digipeat.ts — APRS "New n-N paradigm" digipeating (pure). Given a heard frame and our callsign +
 * served aliases (WIDE1, WIDE2, …), decide whether/how to repeat it: consume our own callsign, or
 * decrement a WIDEn-N hop and insert our callsign with the has-been-repeated mark. Stateful dedup
 * (duplicate suppression) lives in the connector; this transform is pure so it's unit-tested.
 */
import type { ParsedFrame } from "./types.js";
import { sameStation as sameCall } from "./callsign.js";

interface Hop {
  call: string;
  used: boolean;
}

/** AX.25 carries at most 8 digipeater addresses. */
const MAX_DIGIS = 8;

/** A generic n-N routing prefix (`WIDE1`, `WIDE2`, `TEST2`): letters and the hop role, no SSID. */
const isGeneric = (alias: string) => /^[A-Z]{1,5}[1-7]$/.test(alias);

function parseNN(call: string): { base: string; ssid: number } {
  const [base, ss] = call.split("-");
  return { base: (base ?? "").toUpperCase(), ssid: Number(ss ?? 0) || 0 };
}
function rebuild(f: ParsedFrame, hops: Hop[]): ParsedFrame {
  const path = hops.map((h) => h.call + (h.used ? "*" : ""));
  return {
    src: f.src,
    dst: f.dst,
    path,
    payload: f.payload,
    raw: `${f.src}>${f.dst}${path.length ? "," + path.join(",") : ""}:${f.payload}`,
  };
}

export interface DigiOpts {
  mycall: string; // our station callsign
  /**
   * Served aliases, default {WIDE1, WIDE2}. A generic n-N prefix (`WIDE1`, `WIDE2`) matches `WIDE2-2`,
   * `WIDE2-1`…; any other entry (`RELAY`, `EOC-1`) is an alias matched exactly, SSID included.
   */
  aliases?: Set<string>;
}

/**
 * Compute the frame to retransmit, or null if this frame isn't ours to digipeat. We act on the
 * first un-repeated hop only. Does not transmit and does not dedup — the caller owns both.
 */
export function digipeat(f: ParsedFrame, opts: DigiOpts): ParsedFrame | null {
  const mycall = opts.mycall.toUpperCase();
  const aliases = opts.aliases ?? new Set(["WIDE1", "WIDE2"]);
  if (sameCall(f.src, mycall)) return null; // never repeat our own
  const hops: Hop[] = f.path.map((p) => ({ used: p.endsWith("*"), call: p.replace(/\*$/, "") }));

  // already repeated by us? (loop guard)
  if (hops.some((h) => h.used && sameCall(h.call, mycall))) return null;

  const i = hops.findIndex((h) => !h.used);
  if (i < 0) return null; // nothing left to repeat
  const hop = hops[i]!;
  const { base, ssid } = parseNN(hop.call);

  // explicitly routed through us, or through an exact alias we serve: replace it with us, used
  if (sameCall(hop.call, mycall) || [...aliases].some((a) => !isGeneric(a.toUpperCase()) && sameCall(hop.call, a))) {
    hops[i] = { call: mycall, used: true };
    return rebuild(f, hops);
  }
  // served generic n-N prefix with hops remaining
  if (isGeneric(base) && aliases.has(base) && ssid >= 1) {
    if (ssid === 1) {
      hops[i] = { call: mycall, used: true }; // last hop: replace alias with us
    } else {
      hops[i] = { call: `${base}-${ssid - 1}`, used: false }; // decrement…
      // …and insert us (repeated) ahead, while the frame has room for another digipeater address
      if (hops.length < MAX_DIGIS) hops.splice(i, 0, { call: mycall, used: true });
    }
    return rebuild(f, hops);
  }
  return null; // not addressed to an alias we serve
}

/**
 * A duplicate-suppression key: the same source, destination without its SSID, and info field within the
 * window; the path is left out, since each digipeater changes it.
 */
export function dedupeKey(f: ParsedFrame): string {
  return `${f.src.toUpperCase()}>${f.dst.toUpperCase().split("-")[0]}:${f.payload}`;
}
