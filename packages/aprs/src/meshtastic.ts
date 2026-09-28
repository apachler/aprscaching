// SPDX-License-Identifier: MIT
/**
 * meshtastic.ts — decode Meshtastic's protobuf stream (the node's serial / BLE / TCP API framing and the
 * MQTT ServiceEnvelope) and decide which nodes are licensed amateur stations. Pure and runtime-neutral;
 * the connectors (the ingest box, the browser) own the transport.
 *
 * Only a node that runs Meshtastic's licensed (ham) mode enters the map: its NodeInfo carries
 * `User.is_licensed` and its long name is the operator's callsign. A licence-free ISM node has no callsign
 * to show, so it is never given an invented one — its traffic is dropped.
 */
export interface MeshFix {
  node: string;
  lat: number;
  lon: number;
  altitudeM?: number;
  longName?: string;
}

// ---------------------------------------------------------------------------------------------------
// Browser-direct Meshtastic: the node's serial/BLE stream is the protobuf framing
// `0x94 0xC3 <len16-be> <FromRadio…>`. We deframe the stream and pull POSITION_APP fixes out with a
// minimal protobuf reader (canonical field numbers from meshtastic/protobufs). RX-only; no TX here.

const START1 = 0x94,
  START2 = 0xc3,
  MAX_FRAME = 512;

/** Split a Meshtastic serial buffer into complete protobuf frames; `rest` is the unconsumed tail. */
export function deframeMeshtastic(buf: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== START1 || buf[i + 1] !== START2) {
      i++;
      continue;
    } // resync on junk
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len > MAX_FRAME) {
      i++;
      continue;
    } // bogus length → skip a byte
    if (i + 4 + len > buf.length) break; // incomplete → wait for more
    frames.push(buf.subarray(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return { frames, rest: buf.subarray(i) };
}

/**
 * Read a base-128 varint at `p`; returns the value and the next offset. A value past 2^53 cannot be held
 * exactly in a double, so a long varint is decoded as 64 bits and folded to two's complement — a negative
 * int32/int64 (an altitude below sea level) is sign-extended on the wire to a 10-byte varint.
 */
function varint(b: Uint8Array, p: number): [number, number] {
  const start = p;
  let v = 0,
    shift = 0;
  while (p < b.length) {
    const c = b[p++]!;
    v += (c & 0x7f) * 2 ** shift;
    if (!(c & 0x80)) break;
    shift += 7;
  }
  if (shift < 49) return [v, p];
  let big = 0n;
  for (let i = start, s = 0n; i < p && s < 64n; i++, s += 7n) big |= BigInt(b[i]! & 0x7f) << s;
  return [Number(BigInt.asIntN(64, big)), p];
}
const i32le = (b: Uint8Array, p: number): number => new DataView(b.buffer, b.byteOffset + p, 4).getInt32(0, true);

/** Walk one protobuf message, yielding [fieldNumber, wireType, valueOrBytes]. */
function* walk(b: Uint8Array): Generator<[number, number, number | Uint8Array]> {
  let p = 0;
  while (p < b.length) {
    let tag: number;
    [tag, p] = varint(b, p);
    const field = tag >>> 3,
      wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, p] = varint(b, p);
      yield [field, wire, v];
    } else if (wire === 5) {
      if (p + 4 > b.length) break;
      yield [field, wire, i32le(b, p)];
      p += 4;
    } // truncated fixed32 → stop, never read past the frame
    else if (wire === 1) {
      p += 8;
    } // 64-bit (unused) — skip
    else if (wire === 2) {
      let len: number;
      [len, p] = varint(b, p);
      if (len < 0 || p + len > b.length) break;
      yield [field, wire, b.subarray(p, p + len)];
      p += len;
    } else break; // groups/unknown — stop
  }
}
const sub = (b: Uint8Array, want: number): Uint8Array | null => {
  for (const [f, w, v] of walk(b)) if (f === want && w === 2 && v instanceof Uint8Array) return v;
  return null;
};

const nodeId = (from: number): string => `!${(from >>> 0).toString(16).padStart(8, "0")}`;

/** A typed Meshtastic event decoded from a MeshPacket's application payload. */
export type MeshEvent =
  | { kind: "position"; fix: MeshFix }
  | { kind: "text"; node: string; text: string }
  | { kind: "nodeinfo"; node: string; longName?: string; shortName?: string; isLicensed?: boolean };

/** User{ long_name(2), short_name(3), is_licensed(6) }. */
function userFrom(payload: Uint8Array): { longName?: string; shortName?: string; isLicensed?: boolean } {
  const out: { longName?: string; shortName?: string; isLicensed?: boolean } = {};
  for (const [f, w, v] of walk(payload)) {
    if (f === 2 && w === 2 && v instanceof Uint8Array) out.longName = new TextDecoder().decode(v);
    else if (f === 3 && w === 2 && v instanceof Uint8Array) out.shortName = new TextDecoder().decode(v);
    else if (f === 6 && w === 0) out.isLicensed = v !== 0;
  }
  return out;
}

/** The altitude range passed on (metres): a Dead Sea shore to a high balloon. A value outside is a
 *  firmware or GPS glitch, clamped so it never produces an absurd `/A=` field. */
const MIN_ALT_M = -500,
  MAX_ALT_M = 100_000;

/**
 * Position{ latitude_i(1,sfixed32), longitude_i(2,sfixed32), altitude(3,int32) } → a fix (×1e-7 deg), or
 * null.
 */
function positionFrom(payload: Uint8Array, node: string): MeshFix | null {
  let latI: number | null = null,
    lonI: number | null = null,
    alt = 0;
  for (const [f, w, v] of walk(payload)) {
    if (f === 1 && w === 5) latI = v as number;
    else if (f === 2 && w === 5) lonI = v as number;
    else if (f === 3 && w === 0) alt = v as number;
  }
  if (latI == null || lonI == null) return null;
  const lat = latI / 1e7,
    lon = lonI / 1e7;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const fix: MeshFix = { node, lat, lon };
  if (alt) fix.altitudeM = Math.round(Math.min(MAX_ALT_M, Math.max(MIN_ALT_M, alt)));
  return fix;
}

/**
 * Decode one MeshPacket (the shared message inside both FromRadio.packet and ServiceEnvelope.packet) into a
 * typed event. MeshPacket{ from(1,fixed32), decoded(4) } → Data{ portnum(1), payload(2) }; we dispatch the
 * three portnums that matter to us: POSITION_APP(3), TEXT_MESSAGE_APP(1), NODEINFO_APP(4→User). Encrypted
 * packets (no `decoded`) return null. Canonical field numbers from meshtastic/protobufs.
 */
export function parseMeshPacket(packet: Uint8Array): MeshEvent | null {
  let from = 0;
  for (const [f, w, v] of walk(packet)) if (f === 1 && w === 5) from = (v as number) >>> 0;
  const data = sub(packet, 4);
  if (!data) return null; // decoded Data; encrypted → skip
  let portnum = 0;
  let payload: Uint8Array | null = null;
  for (const [f, w, v] of walk(data)) {
    if (f === 1 && w === 0) portnum = v as number;
    else if (f === 2 && w === 2 && v instanceof Uint8Array) payload = v;
  }
  if (!payload) return null;
  const node = nodeId(from);
  if (portnum === 3) {
    const fix = positionFrom(payload, node);
    return fix ? { kind: "position", fix } : null;
  }
  if (portnum === 1) {
    const text = new TextDecoder().decode(payload).replace(/\0+$/, "");
    return text ? { kind: "text", node, text } : null;
  }
  if (portnum === 4) return { kind: "nodeinfo", node, ...userFrom(payload) }; // NODEINFO_APP → User
  return null;
}

/**
 * Decode one FromRadio frame (the node's serial / BLE / TCP API stream) into an event. FromRadio carries a
 * live MeshPacket(2), or — while the client's `want_config` handshake dumps the node database —
 * NodeInfo(4){ num(1), user(2) }, which is where the licence flags of already-known nodes arrive.
 */
export function parseFromRadio(frame: Uint8Array): MeshEvent | null {
  for (const [f, w, v] of walk(frame)) {
    if (f === 2 && w === 2 && v instanceof Uint8Array) return parseMeshPacket(v);
    if (f === 4 && w === 2 && v instanceof Uint8Array) {
      let num: number | null = null;
      let user: Uint8Array | null = null;
      for (const [nf, nw, nv] of walk(v)) {
        if (nf === 1 && nw === 0) num = nv as number;
        else if (nf === 2 && nw === 2 && nv instanceof Uint8Array) user = nv;
      }
      return num != null && user ? { kind: "nodeinfo", node: nodeId(num), ...userFrom(user) } : null;
    }
  }
  return null;
}

/** `ToRadio{ want_config_id }`, framed — asks a node for its database and then its live packet stream. */
export function wantConfigFrame(id = 0x5eed): Uint8Array {
  const body = [0x18, ...varintBytes(id)]; // ToRadio.want_config_id = field 3, varint
  return Uint8Array.from([START1, START2, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
}
/**
 * `ToRadio{ heartbeat }`, framed — an empty Heartbeat (field 7) a client sends periodically so the node
 * keeps its API connection open.
 */
export function heartbeatFrame(): Uint8Array {
  const body = [0x3a, 0x00]; // ToRadio.heartbeat = field 7, length-delimited, empty
  return Uint8Array.from([START1, START2, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
}
function varintBytes(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Licensed-only acceptance

/** An amateur callsign (prefix, digit, suffix ending in a letter) with an optional SSID 0–15. */
const HAM_CALL = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z](?:-(?:[0-9]|1[0-5]))?$/;

/**
 * The callsign a node proves by its NodeInfo, or null. Licensed mode sets `is_licensed` and makes the
 * long name the callsign (`CALL` or `CALL//name`); anything short of both — the flag unset or unknown, or
 * a long name that is not a callsign — proves nothing. The flag is self-asserted, like any callsign on
 * the air: it gates what enters the map, never trust (Meshtastic traffic stays trust-neutral).
 */
export function licensedCallsign(user: { longName?: string; isLicensed?: boolean }): string | null {
  if (user.isLicensed !== true || !user.longName) return null;
  const call = user.longName.split("//")[0]!.trim().toUpperCase().replace(/-0$/, "");
  // N0CALL is the placeholder the firmware accepts in licensed mode (with transmit off): not a station
  return HAM_CALL.test(call) && call.split("-")[0] !== "N0CALL" ? call : null;
}

/**
 * Which Meshtastic nodes are licensed, by node id — learned from NodeInfo, which a licensed node sends
 * every ten minutes and which often arrives after its first positions. Bounded (oldest entry evicted) and
 * time-limited, so a node that stops announcing, or turns licensed mode off, is forgotten.
 */
export class MeshtasticLicensedNodes {
  private nodes = new Map<string, { call: string; at: number }>();
  constructor(private o: { max?: number; ttlMs?: number } = {}) {}

  /** Learn from a decoded event; only NodeInfo changes anything. */
  observe(ev: MeshEvent | null, now = Date.now()): void {
    if (ev?.kind !== "nodeinfo") return;
    const call = licensedCallsign(ev);
    this.nodes.delete(ev.node);
    if (!call) return;
    this.nodes.set(ev.node, { call, at: now });
    const max = this.o.max ?? 2000;
    while (this.nodes.size > max) this.nodes.delete(this.nodes.keys().next().value!);
  }

  /** The node's callsign while its licence is known and fresh, else null. */
  callsignFor(node: string, now = Date.now()): string | null {
    const e = this.nodes.get(node);
    if (!e) return null;
    if (now - e.at > (this.o.ttlMs ?? 6 * 3600_000)) {
      this.nodes.delete(node);
      return null;
    }
    return e.call;
  }

  get size(): number {
    return this.nodes.size;
  }
}

/**
 * Parse a Meshtastic FromRadio frame (browser-direct Meshtastic over serial/BLE) into a position fix,
 * or null. FromRadio.packet(2) → MeshPacket. Non-position events yield null here (position is
 * what the map consumes); use `parseMeshPacket` directly for text/nodeinfo.
 */
export function parseMeshtasticProto(frame: Uint8Array): MeshFix | null {
  const packet = sub(frame, 2);
  if (!packet) return null;
  const ev = parseMeshPacket(packet);
  return ev?.kind === "position" ? ev.fix : null;
}

/**
 * Parse a Meshtastic **MQTT ServiceEnvelope** (native protobuf, ingest-box path) into a typed event, or null.
 * ServiceEnvelope{ packet(1,MeshPacket), channel_id(2), gateway_id(3) } → `parseMeshPacket`. This is the
 * native protobuf MQTT path.
 */
export function parseMeshServiceEnvelope(bytes: Uint8Array): MeshEvent | null {
  const packet = sub(bytes, 1);
  if (!packet) return null;
  return parseMeshPacket(packet);
}
