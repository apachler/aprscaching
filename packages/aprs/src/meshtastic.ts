// SPDX-License-Identifier: MIT
/**
 * meshtastic.ts — parse a Meshtastic MQTT JSON envelope (the gateway's "JSON output" mode) into a
 * position fix. Pure; the connector (apps/ingest) handles the MQTT transport. Protobuf/BLE/serial
 * paths are deeper work tracked separately.
 *
 * Envelope shape (position): { from, sender:"!hex", type:"position",
 *   payload:{ latitude_i, longitude_i, altitude } }
 */
export interface MeshFix { node: string; lat: number; lon: number; altitudeM?: number; longName?: string }

export function parseMeshtasticJson(input: string | Record<string, unknown>): MeshFix | null {
  let o: any;
  try { o = typeof input === "string" ? JSON.parse(input) : input; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  if (o.type && o.type !== "position") return null;
  const p = o.payload ?? o;
  const lat = typeof p.latitude_i === "number" ? p.latitude_i / 1e7 : Number(p.latitude);
  const lon = typeof p.longitude_i === "number" ? p.longitude_i / 1e7 : Number(p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const node = String(o.sender ?? o.from ?? "MESH");
  const fix: MeshFix = { node, lat, lon };
  const alt = Number(p.altitude);
  if (Number.isFinite(alt) && alt !== 0) fix.altitudeM = Math.round(alt);
  if (typeof o.longname === "string") fix.longName = o.longname;
  return fix;
}

// ---------------------------------------------------------------------------------------------------
// Browser-direct Meshtastic: the node's serial/BLE stream is the protobuf framing
// `0x94 0xC3 <len16-be> <FromRadio…>`. We deframe the stream and pull POSITION_APP fixes out with a
// minimal protobuf reader (canonical field numbers from meshtastic/protobufs). RX-only; no TX here.

const START1 = 0x94, START2 = 0xc3, MAX_FRAME = 512;

/** Split a Meshtastic serial buffer into complete protobuf frames; `rest` is the unconsumed tail. */
export function deframeMeshtastic(buf: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== START1 || buf[i + 1] !== START2) { i++; continue; } // resync on junk
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len > MAX_FRAME) { i++; continue; }                            // bogus length → skip a byte
    if (i + 4 + len > buf.length) break;                               // incomplete → wait for more
    frames.push(buf.subarray(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return { frames, rest: buf.subarray(i) };
}

/** Read a base-128 varint at `p`; returns the value and the next offset. */
function varint(b: Uint8Array, p: number): [number, number] {
  let v = 0, shift = 0;
  while (p < b.length) {
    const c = b[p++]!;
    v += (c & 0x7f) * 2 ** shift;
    if (!(c & 0x80)) break;
    shift += 7;
  }
  return [v, p];
}
const i32le = (b: Uint8Array, p: number): number => new DataView(b.buffer, b.byteOffset + p, 4).getInt32(0, true);

/** Walk one protobuf message, yielding [fieldNumber, wireType, valueOrBytes]. */
function* walk(b: Uint8Array): Generator<[number, number, number | Uint8Array]> {
  let p = 0;
  while (p < b.length) {
    let tag: number; [tag, p] = varint(b, p);
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) { let v: number; [v, p] = varint(b, p); yield [field, wire, v]; }
    else if (wire === 5) { if (p + 4 > b.length) break; yield [field, wire, i32le(b, p)]; p += 4; }   // truncated fixed32 → stop, never read past the frame
    else if (wire === 1) { p += 8; }                                   // 64-bit (unused) — skip
    else if (wire === 2) { let len: number; [len, p] = varint(b, p); if (p + len > b.length) break; yield [field, wire, b.subarray(p, p + len)]; p += len; }
    else break;                                                        // groups/unknown — stop
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
  | { kind: "nodeinfo"; node: string; longName?: string; shortName?: string };

/** Position{ latitude_i(1,sfixed32), longitude_i(2,sfixed32), altitude(3) } → a fix (×1e-7 deg), or null. */
function positionFrom(payload: Uint8Array, node: string): MeshFix | null {
  let latI: number | null = null, lonI: number | null = null, alt = 0;
  for (const [f, w, v] of walk(payload)) {
    if (f === 1 && w === 5) latI = v as number;
    else if (f === 2 && w === 5) lonI = v as number;
    else if (f === 3 && w === 0) alt = v as number;
  }
  if (latI == null || lonI == null) return null;
  const lat = latI / 1e7, lon = lonI / 1e7;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const fix: MeshFix = { node, lat, lon };
  if (alt) fix.altitudeM = Math.round(alt);
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
  const data = sub(packet, 4); if (!data) return null;                 // decoded Data; encrypted → skip
  let portnum = 0; let payload: Uint8Array | null = null;
  for (const [f, w, v] of walk(data)) {
    if (f === 1 && w === 0) portnum = v as number;
    else if (f === 2 && w === 2 && v instanceof Uint8Array) payload = v;
  }
  if (!payload) return null;
  const node = nodeId(from);
  if (portnum === 3) { const fix = positionFrom(payload, node); return fix ? { kind: "position", fix } : null; }
  if (portnum === 1) { const text = new TextDecoder().decode(payload).replace(/\0+$/, ""); return text ? { kind: "text", node, text } : null; }
  if (portnum === 4) {                                                  // NODEINFO_APP → User{ long_name(2), short_name(3) }
    let longName: string | undefined, shortName: string | undefined;
    for (const [f, w, v] of walk(payload)) {
      if (f === 2 && w === 2 && v instanceof Uint8Array) longName = new TextDecoder().decode(v);
      else if (f === 3 && w === 2 && v instanceof Uint8Array) shortName = new TextDecoder().decode(v);
    }
    return { kind: "nodeinfo", node, longName, shortName };
  }
  return null;
}

/**
 * Parse a Meshtastic FromRadio frame (serial/BLE H3) into a position fix, or null — the original
 * browser-direct path. FromRadio.packet(2) → MeshPacket. Non-position events yield null here (position is
 * what the map consumes); use `parseMeshPacket` directly for text/nodeinfo.
 */
export function parseMeshtasticProto(frame: Uint8Array): MeshFix | null {
  const packet = sub(frame, 2); if (!packet) return null;
  const ev = parseMeshPacket(packet);
  return ev?.kind === "position" ? ev.fix : null;
}

/**
 * Parse a Meshtastic **MQTT ServiceEnvelope** (native protobuf Path A) into a typed event, or null.
 * ServiceEnvelope{ packet(1,MeshPacket), channel_id(2), gateway_id(3) } → `parseMeshPacket`. This is the
 * native protobuf MQTT path (many brokers publish protobuf, not the JSON `parseMeshtasticJson` handles).
 */
export function parseMeshServiceEnvelope(bytes: Uint8Array): MeshEvent | null {
  const packet = sub(bytes, 1); if (!packet) return null;
  return parseMeshPacket(packet);
}
