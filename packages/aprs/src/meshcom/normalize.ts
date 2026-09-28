// SPDX-License-Identifier: MIT
/**
 * MeshCom datagram → normalised event with provenance.
 *
 * Provenance rules (docs/design/meshcom.md):
 *   - `rf` — the receiving node heard the frame over LoRa. Only `src_type: lora` qualifies, and not when
 *     the origin is the receiving node itself: the firmware reports its own back-pressure notices as
 *     `lora` from its own call with a zero signal report, although they never went on air.
 *   - `direct` — an RF frame whose source path is the originator alone (no relay). Only a direct frame
 *     can later be tied to an attested receiver; a relayed frame is RF-observed but corroborates nothing
 *     about where its originator was.
 * `src_type: udp` (relayed by the MeshCom server over the internet) and `node` (the node's own traffic)
 * are never RF. Trust itself is decided by the gateway's provenance derivation, not here.
 */
import { toMaidenhead } from "../geo.js";
import { parseMeshcomDatagram, type MeshcomDatagram, type MeshcomRejectReason, type MeshcomSrcType } from "./parse.js";

export interface MeshcomContext {
  /** Callsigns of the node(s) delivering datagrams; a frame they originate is never RF. */
  receiverCalls?: readonly string[];
}

export interface MeshcomProvenance {
  srcType: MeshcomSrcType;
  rf: boolean;
  direct: boolean;
  /** Full source path: originator first, then each relay. */
  path: string[];
  msgId?: string;
  rssi?: number;
  snr?: number;
  firmware?: string;
}

export type MeshcomDstKind = "call" | "group" | "all";

interface EventBase {
  /** Canonical originating callsign. */
  src: string;
  provenance: MeshcomProvenance;
  raw: Record<string, unknown>;
}

export interface MeshcomPosEvent extends EventBase {
  type: "pos";
  lat: number;
  lon: number;
  /** 6-character Maidenhead locator of the fix. */
  locator: string;
  /** APRS symbol as table + code (e.g. `/#`). */
  symbol?: string;
  batt?: number;
}

export interface MeshcomMsgEvent extends EventBase {
  type: "msg";
  dst: string;
  dstKind: MeshcomDstKind;
  /** Message text, control characters collapsed to single spaces. */
  text: string;
}

export interface MeshcomTeleEvent extends EventBase {
  type: "tele";
  values: Record<string, number>;
  din?: string;
}

export type MeshcomEvent = MeshcomPosEvent | MeshcomMsgEvent | MeshcomTeleEvent;

export type MeshcomDecodeResult = { ok: true; event: MeshcomEvent } | { ok: false; reason: MeshcomRejectReason };

/**
 * An amateur callsign with an optional SSID. MeshCom SSIDs run past the AX.25 0–15 range (`-99`), as
 * APRS-IS text calls do. The base call must hold both a letter and a digit, which separates calls from
 * group numbers and from firmware-internal sources such as `HOME`.
 */
const CALL = /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,7}(?:-[A-Z0-9]{1,2})?$/;

/** Canonical callsign (trimmed, upper-case), or null when the token is not a callsign. */
export function canonMeshcomCall(s: string): string | null {
  const c = s.trim().toUpperCase();
  return c.length <= 9 && CALL.test(c) ? c : null;
}

/** Destination class per the firmware's CheckGroup: `*`, a group 1–99999, or a callsign. */
export function classifyMeshcomDst(dst: string): { dst: string; kind: MeshcomDstKind } | null {
  const d = dst.trim().toUpperCase();
  if (d === "*") return { dst: d, kind: "all" };
  if (/^\d{1,5}$/.test(d)) {
    const g = Number(d);
    return g >= 1 && g <= 99999 ? { dst: String(g), kind: "group" } : null;
  }
  const call = canonMeshcomCall(d);
  return call ? { dst: call, kind: "call" } : null;
}

/** Collapse control characters (including NUL) to single spaces and trim. */
export function collapseControls(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** Path tokens beyond this are not a MeshCom path (the firmware's hop limit is far lower). */
const MAX_PATH = 9;

/** Normalise one parsed datagram. */
export function normalizeMeshcom(d: MeshcomDatagram, ctx: MeshcomContext = {}): MeshcomDecodeResult {
  const hops = d.src.split(",").filter((h) => h.trim() !== "");
  if (hops.length === 0 || hops.length > MAX_PATH) return { ok: false, reason: "bad-src" };
  const path: string[] = [];
  for (const h of hops) {
    const c = canonMeshcomCall(h);
    if (!c) return { ok: false, reason: "bad-src" };
    path.push(c);
  }
  const src = path[0]!;

  const receivers = new Set((ctx.receiverCalls ?? []).map((c) => c.trim().toUpperCase()));
  const zeroSignal = d.rssi === 0 && d.snr === 0;
  const rf = d.srcType === "lora" && !receivers.has(src) && !zeroSignal;
  const provenance: MeshcomProvenance = {
    srcType: d.srcType,
    rf,
    direct: rf && path.length === 1,
    path,
    ...(d.msgId !== undefined && /^[0-9A-F]{1,8}$/i.test(d.msgId) ? { msgId: d.msgId.toUpperCase() } : {}),
    ...(d.rssi !== undefined ? { rssi: d.rssi } : {}),
    ...(d.snr !== undefined ? { snr: d.snr } : {}),
    ...(d.firmware !== undefined ? { firmware: d.firmware } : {}),
  };
  const base: EventBase = { src, provenance, raw: d.raw };

  if (d.type === "pos") {
    if (d.lat < 0 || d.lat > 90 || d.lon < 0 || d.lon > 180) return { ok: false, reason: "bad-position" };
    if (d.lat === 0 && d.lon === 0) return { ok: false, reason: "no-fix" };
    const lat = d.latDir === "S" ? -d.lat : d.lat;
    const lon = d.lonDir === "W" ? -d.lon : d.lon;
    const symbol = d.symbolCode !== undefined ? `${d.symbolTable ?? "/"}${d.symbolCode}` : undefined;
    return {
      ok: true,
      event: {
        ...base,
        type: "pos",
        lat,
        lon,
        locator: toMaidenhead(lat, lon),
        ...(symbol !== undefined ? { symbol } : {}),
        ...(d.batt !== undefined && d.batt >= 0 && d.batt <= 100 ? { batt: d.batt } : {}),
      },
    };
  }

  if (d.type === "msg") {
    const dst = classifyMeshcomDst(d.dst.split(",")[0]!);
    if (!dst) return { ok: false, reason: "bad-dst" };
    const text = collapseControls(d.text);
    if (!text) return { ok: false, reason: "empty-text" };
    return { ok: true, event: { ...base, type: "msg", dst: dst.dst, dstKind: dst.kind, text } };
  }

  return { ok: true, event: { ...base, type: "tele", values: d.values, ...(d.din ? { din: d.din } : {}) } };
}

/** Parse and normalise in one step. */
export function decodeMeshcom(input: Uint8Array | string, ctx: MeshcomContext = {}): MeshcomDecodeResult {
  const p = parseMeshcomDatagram(input);
  return p.ok ? normalizeMeshcom(p.datagram, ctx) : p;
}
