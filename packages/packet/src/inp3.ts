// SPDX-License-Identifier: MIT
/**
 * inp3.ts — the INP3 (Improved NET/ROM, "Inter-Node Protocol 3") routing wire, reimplemented from
 * the open protocol ("A New Routing Specification for Packet Radio Datagram Networks", DL1GJI) and
 * the TheNetNode reference implementation. INP3 replaces classic NODES broadcasts with **triggered,
 * point-to-point Routing Information Frames (RIFs)** carrying a round-trip-time metric instead of a
 * 0–255 quality, so networks converge faster and rank routes by measured latency.
 *
 * Pure, zero-I/O, unit-tested; the node engine (inp3-node.ts) drives it, the ingest wires it to RF.
 *
 * RIF wire (a NET/ROM L3 info field whose first byte is 0xFF, like a NODES broadcast, but sent to a
 * specific neighbour rather than flooded to "NODES"):
 *   0xFF  then a sequence of RIP entries, each:
 *     dest call  (7 bytes, AX.25 shifted)
 *     hops       (1 byte)
 *     tt         (2 bytes, big-endian — the round-trip "transport time" in 10 ms units)
 *     options    zero or more { length (incl. these 2 bytes) · type · data[length-2] }
 *     0x00       end-of-options (EOP) closes this entry's option list
 *   Option types: 0 = ALIAS (6 ASCII), 1 = IP (4-byte address + 1-byte subnet-bits).
 *
 * L3RTT (the RTT probe): a NET/ROM L4 frame to the pseudo-destination "L3RTT", TTL 2, opcode 0x05,
 * info = "L3RTT:" + fields; a node that receives its OWN L3RTT back measures the round trip. tt of a
 * route is derived from the smoothed RTT (half the measured round trip).
 */
import { encodeAddress, decodeAddress, parseAddr, type Ax25Address } from "@aprscaching/ax25";
import { encodeNetrom, decodeNetrom, type NrPacket } from "./netrom-wire.js";

export const INP_RIF = 0xff; // RIF discriminator (first info byte)
export const INP_EOP = 0x00; // end-of-options marker
export const INP_OPT_ALIAS = 0; // option type: node alias (6 ASCII)
export const INP_OPT_IP = 1; // option type: IP address + subnet bits

export const INP_MAX_HOPS = 30; // horizon: routes beyond this many hops are not added (TheNetNode max_lt)
export const INP_TT_WITHDRAW = 60000; // tt value that withdraws (deregisters) a route
export const INP_TT_DIRECT = 1; // tt of a direct neighbour (≈10 ms)

/** One route entry in a RIF. tt is in 10 ms units (the round-trip transport time). */
export interface Rip {
  dest: Ax25Address;
  hops: number;
  tt: number;
  alias?: string; // 6-char node mnemonic (ALIAS option)
  ip?: { addr: [number, number, number, number]; bits: number }; // IP option
}

const shifted = (a: Ax25Address): Uint8Array => encodeAddress(a, false, false).subarray(0, 7);

/** Encode a set of RIP entries into one RIF info field (caller chunks to the link's frame budget). */
export function encodeRif(rips: Rip[]): Uint8Array {
  const out: number[] = [INP_RIF];
  for (const r of rips) {
    out.push(...shifted(r.dest));
    out.push(r.hops & 0xff);
    out.push((r.tt >> 8) & 0xff, r.tt & 0xff); // big-endian tt
    if (r.alias) {
      const a = padAscii(r.alias, 6);
      out.push(2 + a.length, INP_OPT_ALIAS, ...a); // length includes the length+type bytes
    }
    if (r.ip) {
      out.push(2 + 5, INP_OPT_IP, ...r.ip.addr, r.ip.bits & 0xff);
    }
    out.push(INP_EOP); // close this entry's options
  }
  return Uint8Array.from(out);
}

/** Decode a RIF info field into its RIP entries, or null if it isn't a RIF. Tolerant of truncation. */
export function decodeRif(info: Uint8Array): Rip[] | null {
  if (info.length < 1 || info[0] !== INP_RIF) return null;
  const rips: Rip[] = [];
  let o = 1;
  while (o + 10 <= info.length) {
    const dest = decodeAddress(info, o).addr;
    o += 7;
    const hops = info[o++]!;
    const tt = (info[o]! << 8) | info[o + 1]!;
    o += 2;
    const rip: Rip = { dest, hops, tt };
    // options until EOP (a zero length byte)
    for (;;) {
      if (o >= info.length) break;
      const len = info[o]!;
      if (len === INP_EOP) {
        o += 1;
        break;
      }
      const type = info[o + 1]!;
      const data = info.subarray(o + 2, o + len); // len includes the length+type bytes
      if (type === INP_OPT_ALIAS) rip.alias = new TextDecoder().decode(data).replace(/[\s\0]+$/, "");
      else if (type === INP_OPT_IP && data.length >= 5)
        rip.ip = { addr: [data[0]!, data[1]!, data[2]!, data[3]!], bits: data[4]! };
      o += len;
    }
    rips.push(rip);
  }
  return rips;
}

// ---- L3RTT (round-trip-time probe) ----

/** Fields carried in an L3RTT info payload. */
export interface L3rtt {
  origin: string; // the measuring node's callsign (echoed verbatim so it recognises its own probe)
  seq: number; // 10 ms tick / sequence stamp
  alias: string;
}

/** The pseudo-destination every L3RTT probe is addressed to. */
export const L3RTT_DEST = "L3RTT";

/** Build the info payload of an L3RTT probe (the "L3RTT:" text form TheNetNode emits). */
export function encodeL3rtt(p: L3rtt): Uint8Array {
  // "L3RTT:<seq> <origin> <alias> LEVEL3_V2.1" — the seq + origin are what the sender matches on return.
  return new TextEncoder().encode(`L3RTT:${p.seq} ${p.origin} ${p.alias.slice(0, 6)} LEVEL3_V2.1`);
}

/** Parse an L3RTT info payload; null if it isn't one. */
export function decodeL3rtt(info: Uint8Array): L3rtt | null {
  const s = new TextDecoder().decode(info);
  const m = /^L3RTT:(\d+)\s+(\S+)\s+(\S+)/.exec(s);
  if (!m) return null;
  return { seq: Number(m[1]), origin: m[2]!, alias: m[3]!.replace(/[\s\0]+$/, "") };
}

/**
 * Build the full NET/ROM L4 frame carrying an L3RTT probe: origin = the measuring node, dest = the
 * `L3RTT` pseudo-callsign, TTL 2, opcode 0x05 (TheNetNode's l3rtt.c). The frame floods to neighbours
 * who echo it back; the origin recognises its own probe by the origin field and the `seq` token.
 */
export function encodeL3rttFrame(originCall: Ax25Address, p: L3rtt): Uint8Array {
  const frame: NrPacket = {
    net: { origin: originCall, dest: parseAddr(L3RTT_DEST), ttl: 2 },
    tp: { opcode: 0x05, flags: 0, circuitIndex: 0, circuitId: 0, txSeq: 0, rxSeq: 0 },
    info: encodeL3rtt(p),
  };
  return encodeNetrom(frame);
}

/** Decode a NET/ROM frame and return its L3RTT payload if it is an L3RTT probe, else null. */
export function decodeL3rttFrame(bytes: Uint8Array): { origin: Ax25Address; rtt: L3rtt } | null {
  const nr = decodeNetrom(bytes);
  if (!nr || nr.net.dest.call.toUpperCase().trimEnd() !== L3RTT_DEST) return null;
  const rtt = decodeL3rtt(nr.info);
  return rtt ? { origin: nr.net.origin, rtt } : null;
}

/**
 * Smoothed round-trip time (TheNetNode's exponential average): srtt' = (7·srtt + rtt) / 8, seeded to
 * the first sample. Both in 10 ms units. Returns the new smoothed value.
 */
export function smoothRtt(prevSrtt: number | null, sample: number): number {
  if (prevSrtt == null || prevSrtt <= 0) return sample;
  return Math.round((7 * prevSrtt + sample) / 8);
}

/** A route's tt contribution from a neighbour is half the measured round trip (TheNetNode rtt/2). */
export function ttFromRtt(srtt: number): number {
  return Math.max(INP_TT_DIRECT, Math.round(srtt / 2));
}

// ---- helpers ----
function padAscii(s: string, n: number): number[] {
  const b = Array.from(new TextEncoder().encode(s.slice(0, n)));
  while (b.length < n) b.push(0x20);
  return b;
}
