// SPDX-License-Identifier: MIT
/**
 * digipeat.ts — APRS "New n-N paradigm" digipeating (pure). Given a heard frame and our callsign +
 * served aliases (WIDE1, WIDE2, …), decide whether/how to repeat it: consume our own callsign, or
 * decrement a WIDEn-N hop and insert our callsign with the has-been-repeated mark. Stateful dedup
 * (duplicate suppression) lives in the connector; this transform is pure so it's unit-tested.
 */
import type { ParsedFrame } from "./types.js";

interface Hop {
  call: string;
  used: boolean;
}

/**
 * The same station: callsign and SSID equal, `-0` the same as none. Another SSID of the operator's base call
 * is another station (their handheld, their car), which the digipeater repeats like anyone else's.
 */
const sameCall = (a: string, b: string) => {
  const norm = (c: string) => c.toUpperCase().replace(/-0$/, "");
  return norm(a) === norm(b);
};
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
  aliases?: Set<string>; // served n-N alias bases, default {WIDE1, WIDE2}
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

  // explicitly routed through us
  if (sameCall(hop.call, mycall)) {
    hops[i] = { call: mycall, used: true };
    return rebuild(f, hops);
  }
  // served WIDEn-N alias with hops remaining
  if (aliases.has(base) && ssid >= 1) {
    if (ssid === 1) {
      hops[i] = { call: mycall, used: true }; // last hop: replace alias with us
    } else {
      hops[i] = { call: `${base}-${ssid - 1}`, used: false }; // decrement…
      hops.splice(i, 0, { call: mycall, used: true }); // …and insert us (repeated) ahead
    }
    return rebuild(f, hops);
  }
  return null; // not addressed to an alias we serve
}

/** A duplicate-suppression key: same source, destination and payload within the dedup window. */
export function dedupeKey(f: ParsedFrame): string {
  return `${f.src.toUpperCase()}>${f.dst.toUpperCase()}:${f.payload}`;
}
