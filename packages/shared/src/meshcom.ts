// SPDX-License-Identifier: MIT
/**
 * MeshCom metadata carried with a MeshCom packet from the ingest to the gateway (`parsed.meshcom`): how
 * the receiving node got the frame and what the frame said about its sender's device. It is display
 * information only — the gateway's trust derivation never reads it.
 *
 * Both ends sanitise it with {@link sanitizeMeshcomMeta}: a field that is missing, of the wrong type or
 * out of range is dropped, never guessed or clamped.
 */

/** How the receiving node got the frame: over LoRa, relayed by the MeshCom server, or its own traffic. */
export type MeshcomSrcType = "lora" | "udp" | "node";

export interface MeshcomMeta {
  srcType?: MeshcomSrcType;
  /** Heard over LoRa straight from its originator, with no relay. */
  direct?: boolean;
  /** The source path, originator first, then each relay. */
  path?: string[];
  /** The node that received the frame. */
  receiver?: string;
  /** Signal report of a LoRa hearing, dBm and dB. */
  rssi?: number;
  snr?: number;
  /** The MeshCom hardware id of the sender's device. */
  hwId?: number;
  firmware?: string;
  /** Battery, percent. */
  batt?: number;
}

const CALL = /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,7}(?:-[A-Z0-9]{1,2})?$/;
const FIRMWARE = /^[0-9A-Za-z._-]{1,16}$/;
/** Relays beyond this are not a MeshCom path (the firmware's hop limit is far lower). */
const MAX_PATH = 9;

const isCall = (v: unknown): v is string => typeof v === "string" && v.length <= 10 && CALL.test(v);
const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** The valid fields of an untrusted value, or null when none is valid. */
export function sanitizeMeshcomMeta(v: unknown): MeshcomMeta | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const m: MeshcomMeta = {};
  if (o.srcType === "lora" || o.srcType === "udp" || o.srcType === "node") m.srcType = o.srcType;
  if (typeof o.direct === "boolean") m.direct = o.direct;
  if (Array.isArray(o.path) && o.path.length >= 1 && o.path.length <= MAX_PATH && o.path.every(isCall))
    m.path = [...o.path];
  if (isCall(o.receiver)) m.receiver = o.receiver;
  // a signal report belongs to a LoRa hearing only
  if (m.srcType === "lora") {
    if (inRange(o.rssi, -150, 0)) m.rssi = o.rssi;
    if (inRange(o.snr, -40, 30)) m.snr = o.snr;
  }
  if (inRange(o.hwId, 0, 255) && Number.isInteger(o.hwId)) m.hwId = o.hwId;
  if (typeof o.firmware === "string" && FIRMWARE.test(o.firmware)) m.firmware = o.firmware;
  if (inRange(o.batt, 0, 100)) m.batt = Math.round(o.batt);
  return Object.keys(m).length ? m : null;
}

/** Plain-language signal quality of a LoRa hearing: SNR decides where it is known, else RSSI. */
export type MeshcomQuality = "strong" | "usable" | "weak";

export function meshcomQuality(m: { rssi?: number | null; snr?: number | null }): MeshcomQuality | null {
  if (m.snr != null) return m.snr >= 5 ? "strong" : m.snr >= -7 ? "usable" : "weak";
  if (m.rssi != null) return m.rssi >= -90 ? "strong" : m.rssi >= -110 ? "usable" : "weak";
  return null;
}

/** A battery level as shown to a visitor who is not signed in. */
export type MeshcomBattLevel = "high" | "medium" | "low";

export function meshcomBattLevel(batt: number | null | undefined): MeshcomBattLevel | null {
  if (batt == null) return null;
  return batt >= 60 ? "high" : batt >= 25 ? "medium" : "low";
}
