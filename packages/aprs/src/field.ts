/**
 * field.ts — the pure "field station" core (docs/16 A/B/D). Off-grid, the browser is a first-class LOCAL
 * APRS engine: decoded RF frames become live stations on the map + messages in a local inbox, with online
 * an enhancement, not a requirement. This module is I/O-free — it maps a decoded frame to a local event
 * (A), builds an ACK for a message addressed to us (B), and shapes locally-heard receptions for sync-back
 * (D). The client store + radio TX + IndexedDB live in `apps/web`; this stays reusable + unit-tested.
 */
import type { ParsedFrame, AprsData } from "./types.js";
import { encodeAprsMessage } from "./encode.js";

const baseCall = (c: string) => c.replace(/\*$/, "").split("-")[0]!.toUpperCase();
const cleanCall = (c: string) => c.replace(/\*$/, "").toUpperCase();

export interface LocalStation {
  callsign: string; lat: number; lon: number;
  symbol?: string;              // 2-char table+code, e.g. "/>"; undefined if unknown
  course?: number; speedKn?: number; altitudeM?: number; comment?: string;
  kind: "station" | "object" | "item" | "weather";
  heardAt: number;              // epoch ms
}
export interface LocalMessage {
  from: string; to: string; text: string; msgNo?: string;
  ack: boolean; rej: boolean; at: number;   // epoch ms
}
export type LocalEvent =
  | { kind: "station"; station: LocalStation }
  | { kind: "message"; message: LocalMessage }
  | { kind: "none" };

/** (A) Map a decoded RF frame to a local field-station event — a station fix or an inbox message. Pure. */
export function localEvent(frame: ParsedFrame, data: AprsData, at: number): LocalEvent {
  if (data.kind === "position" || data.kind === "object" || data.kind === "item" || data.kind === "weather") {
    const lat = data.lat, lon = data.lon;
    if (typeof lat !== "number" || typeof lon !== "number") return { kind: "none" };
    const named = (data.kind === "object" || data.kind === "item") ? cleanCall((data as { name: string }).name) : cleanCall(frame.src);
    const sym = data.symbol ? `${data.symbol.table}${data.symbol.code}` : undefined;
    return { kind: "station", station: {
      callsign: named, lat, lon, symbol: sym,
      course: data.course, speedKn: data.speedKn, altitudeM: data.altitudeM, comment: data.comment,
      kind: data.kind === "position" ? "station" : data.kind, heardAt: at,
    } };
  }
  if (data.kind === "message" && !data.bulletin) {
    return { kind: "message", message: {
      from: cleanCall(frame.src), to: cleanCall(data.addressee), text: data.text, msgNo: data.msgNo,
      ack: !!data.ack, rej: !!data.rej, at,
    } };
  }
  return { kind: "none" };
}

/** True if this message is addressed to our base call (SSID-agnostic) and is real text (not an ack/rej). */
export function messageForMe(msg: LocalMessage, myCall: string): boolean {
  return !msg.ack && !msg.rej && baseCall(msg.to) === baseCall(myCall);
}

/**
 * (B) Build the ACK info field for a message addressed to us, or null if none is due (no msgNo, or it's
 * itself an ack/rej, or not for us). Send it back over the radio via KISS (H5-gated) — client-side.
 */
export function ackReply(msg: LocalMessage, myCall: string): string | null {
  if (!msg.msgNo || !messageForMe(msg, myCall)) return null;
  return encodeAprsMessage(msg.from, `ack${msg.msgNo}`);
}

/** A locally-heard RF reception, ready to replay to a gateway when connectivity returns (D). */
export interface HeardReception { raw: string; at: number }
/**
 * (D) Shape locally-heard receptions into ingest packets for sync-back. Dedupes identical raw frames,
 * caps the batch, and drops our own transmissions (we already forwarded those). RX ≠ trust — the gateway
 * still gates every reception via verify.ts regardless of transport.
 */
export function syncBackBatch(heard: HeardReception[], myCall: string, cap = 200): { raw: string; at: number }[] {
  const mine = baseCall(myCall);
  const seen = new Set<string>();
  const out: { raw: string; at: number }[] = [];
  for (const h of heard) {
    if (!h.raw || seen.has(h.raw)) continue;
    const src = h.raw.split(">")[0] ?? "";
    if (baseCall(src) === mine) continue;   // don't replay our own beacons
    seen.add(h.raw);
    out.push({ raw: h.raw, at: h.at });
    if (out.length >= cap) break;
  }
  return out;
}
