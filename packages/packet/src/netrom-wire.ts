/**
 * netrom-wire.ts — the NET/ROM L3/L4 wire codec (docs/29 F2), reimplemented from the open NET/ROM
 * protocol spec ("The NET/ROM Protocol"). Pure, zero-I/O, unit-tested; the ingest wires it to real RF
 * (validate-at-deploy). This is only the framing + the NODES-broadcast codec — the L4 circuit state
 * machine lives in netrom-circuit.ts, and route maths in netrom.ts.
 *
 * Inter-node frame  = AX.25 header (PID 0xCF) + 15-byte network header + 5-byte transport header + info.
 *   Network header  = origin call (7, AX.25 shifted) · dest call (7, shifted, EOA) · time-to-live (1).
 *   Transport hdr   = circuit index (1) · circuit id (1) · tx seq (1) · rx seq (1) · opcode&flags (1).
 * NODES broadcast   = AX.25 UI to "NODES", info = 0xFF · sender mnemonic (6 ASCII) · per-dest records
 *   { dest call (7 shifted) · dest mnemonic (6 ASCII) · best-neighbor call (7 shifted) · quality (1) },
 *   up to 11 per UI frame.
 */
import { encodeAddress, decodeAddress, type Ax25Address } from "@aprsweb/ax25";

export const NETROM_PID = 0xcf;

/** L4 transport opcodes (low nibble of the opcode&flags byte). */
export const NrOp = { ConnReq: 1, ConnAck: 2, DiscReq: 3, DiscAck: 4, Info: 5, InfoAck: 6 } as const;
export type NrOpcode = (typeof NrOp)[keyof typeof NrOp];

/** Flag bits in the opcode&flags byte. */
export const NR_CHOKE = 0x80; // this node cannot accept more info right now
export const NR_NAK = 0x40;   // selective retransmit requested (of rx-seq)
export const NR_MORE = 0x20;  // this info is a fragment; more follows

export interface NrNetHeader { origin: Ax25Address; dest: Ax25Address; ttl: number }
export interface NrTransport { opcode: number; flags: number; circuitIndex: number; circuitId: number; txSeq: number; rxSeq: number }
export interface NrPacket { net: NrNetHeader; tp: NrTransport; info: Uint8Array }

// The network-header callsigns are "AX.25 shifted format". encodeAddress(a, cbit, last) writes the
// 7-byte shifted form; the c-bit/reserved bits carry no L3 meaning here, so we fix cbit=false and set
// EOA (last=true) only on the dest, mirroring the spec's "w/EOA bit" note. decodeAddress reads 7 bytes.
const putCall = (a: Ax25Address, last: boolean) => encodeAddress(a, false, last);
const getCall = (b: Uint8Array, off: number): Ax25Address => decodeAddress(b, off).addr;

/** Encode a NET/ROM inter-node packet (the info that rides inside an AX.25 UI/I frame with PID 0xCF). */
export function encodeNetrom(p: NrPacket): Uint8Array {
  const out = new Uint8Array(15 + 5 + p.info.length);
  out.set(putCall(p.net.origin, false), 0);
  out.set(putCall(p.net.dest, true), 7);
  out[14] = p.net.ttl & 0xff;
  out[15] = p.tp.circuitIndex & 0xff;
  out[16] = p.tp.circuitId & 0xff;
  out[17] = p.tp.txSeq & 0xff;
  out[18] = p.tp.rxSeq & 0xff;
  out[19] = ((p.tp.flags & 0xe0) | (p.tp.opcode & 0x0f)) & 0xff;
  out.set(p.info, 20);
  return out;
}

/** Decode a NET/ROM inter-node packet. Returns null if the buffer is too short for the fixed headers. */
export function decodeNetrom(b: Uint8Array): NrPacket | null {
  if (b.length < 20) return null;
  const opByte = b[19]!;
  return {
    net: { origin: getCall(b, 0), dest: getCall(b, 7), ttl: b[14]! },
    tp: {
      circuitIndex: b[15]!, circuitId: b[16]!, txSeq: b[17]!, rxSeq: b[18]!,
      opcode: opByte & 0x0f, flags: opByte & 0xe0,
    },
    info: b.slice(20),
  };
}

// ---- NODES broadcast ----
export interface NodesDest { dest: Ax25Address; alias: string; neighbor: Ax25Address; quality: number }

const NODES_SIG = 0xff;
const MAX_DESTS_PER_FRAME = 11;
/** 6-byte space-padded ASCII mnemonic (uppercased, control-stripped). */
const putAlias = (s: string): Uint8Array => {
  const out = new Uint8Array(6).fill(0x20);
  const t = s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
};
const getAlias = (b: Uint8Array, off: number): string => {
  let s = "";
  for (let i = 0; i < 6; i++) s += String.fromCharCode(b[off + i]!);
  return s.trimEnd();
};

/**
 * Encode one node's routing table as NODES-broadcast info fields, chunked to ≤11 destinations per frame
 * (each becomes the info of a UI frame to "NODES", PID 0xCF). Returns one Uint8Array per UI frame.
 */
export function encodeNodesBroadcast(senderAlias: string, dests: NodesDest[]): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const alias = putAlias(senderAlias);
  for (let i = 0; i < Math.max(dests.length, 1); i += MAX_DESTS_PER_FRAME) {
    const chunk = dests.slice(i, i + MAX_DESTS_PER_FRAME);
    const out = new Uint8Array(7 + chunk.length * 21);
    out[0] = NODES_SIG;
    out.set(alias, 1);
    let off = 7;
    for (const d of chunk) {
      out.set(putCall(d.dest, true), off);
      out.set(putAlias(d.alias), off + 7);
      out.set(putCall(d.neighbor, true), off + 13);
      out[off + 20] = d.quality & 0xff;
      off += 21;
    }
    frames.push(out);
    if (dests.length === 0) break;
  }
  return frames;
}

/** Decode a NODES-broadcast info field. Returns null if the signature is wrong or the buffer is short. */
export function decodeNodesBroadcast(info: Uint8Array): { senderAlias: string; dests: NodesDest[] } | null {
  if (info.length < 7 || info[0] !== NODES_SIG) return null;
  const senderAlias = getAlias(info, 1);
  const dests: NodesDest[] = [];
  for (let off = 7; off + 21 <= info.length; off += 21) {
    dests.push({
      dest: getCall(info, off),
      alias: getAlias(info, off + 7),
      neighbor: getCall(info, off + 13),
      quality: info[off + 20]!,
    });
  }
  return { senderAlias, dests };
}

/**
 * NET/ROM route-quality update (spec §Automatic Routing Table Updates): combine a broadcast route
 * quality with the path quality of the neighbour that sent it. `routeQuality = (bcast × path + 128) / 256`.
 */
export const combineQuality = (broadcastQuality: number, pathQuality: number): number =>
  Math.floor((broadcastQuality * pathQuality + 128) / 256);
