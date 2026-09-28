// SPDX-License-Identifier: MIT
/**
 * MeshCom ExtUDP datagram → typed record. Tolerant and total: every input yields either a record or a
 * structured rejection reason, never a throw. Field contract: docs/reference/meshcom-extudp.md, verified
 * against the MIT MeshCom firmware (`src/extudp_functions.cpp`, `src/extern_tele_json.h`).
 *
 * This layer checks shape only — types and presence. Meaning (hemisphere signs, callsign rules, ranges,
 * provenance) is `normalize.ts`.
 */

export type MeshcomSrcType = "lora" | "udp" | "node";

export type MeshcomRejectReason =
  | "too-large"
  | "bad-utf8"
  | "not-json"
  | "not-object"
  | "unknown-src-type"
  | "unknown-type"
  | "bad-src"
  | "bad-position"
  | "no-fix"
  | "bad-dst"
  | "empty-text";

interface DatagramBase {
  srcType: MeshcomSrcType;
  /** The comma-separated source path exactly as sent. */
  src: string;
  msgId?: string;
  /** Firmware as `<version><sub>`, e.g. `4.35t` for the node itself or `35p` for a received frame. */
  firmware?: string;
  rssi?: number;
  snr?: number;
  /** Every field of the datagram as received, known or not. */
  raw: Record<string, unknown>;
}

export interface MeshcomPosDatagram extends DatagramBase {
  type: "pos";
  lat: number;
  latDir: "N" | "S";
  lon: number;
  lonDir: "E" | "W";
  symbolTable?: string;
  symbolCode?: string;
  /** Raw `/A=` value — feet or metres depending on the sending node, so never interpreted. */
  altRaw?: number;
  batt?: number;
  hwId?: number;
}

export interface MeshcomMsgDatagram extends DatagramBase {
  type: "msg";
  dst: string;
  text: string;
}

export interface MeshcomTeleDatagram extends DatagramBase {
  type: "tele";
  values: Record<string, number>;
  din?: string;
}

export type MeshcomDatagram = MeshcomPosDatagram | MeshcomMsgDatagram | MeshcomTeleDatagram;

export type MeshcomParseResult = { ok: true; datagram: MeshcomDatagram } | { ok: false; reason: MeshcomRejectReason };

/** Upper bound on an accepted datagram. The firmware's JSON buffer is 500 bytes; 2 KiB leaves slack. */
export const MESHCOM_MAX_DATAGRAM = 2048;

/** Numeric telemetry keys the firmware emits (`extern_tele_json.h`). */
const TELE_KEYS = ["batt", "temp1", "temp2", "hum", "qfe", "qnh", "pressure_alt", "gas", "co2"] as const;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** First character of a symbol field; the firmware doubles a backslash before serialising. */
const symbolChar = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const c = s[0]!;
  const code = c.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e ? c : undefined;
};

const reject = (reason: MeshcomRejectReason): MeshcomParseResult => ({ ok: false, reason });

/** Parse one datagram (bytes or already-decoded text). */
export function parseMeshcomDatagram(input: Uint8Array | string): MeshcomParseResult {
  let text: string;
  if (typeof input === "string") {
    if (input.length > MESHCOM_MAX_DATAGRAM) return reject("too-large");
    text = input;
  } else {
    if (input.byteLength > MESHCOM_MAX_DATAGRAM) return reject("too-large");
    try {
      text = utf8.decode(input);
    } catch {
      return reject("bad-utf8");
    }
  }

  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return reject("not-json");
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return reject("not-object");
  const raw = o as Record<string, unknown>;

  const srcType = raw.src_type;
  if (srcType !== "lora" && srcType !== "udp" && srcType !== "node") return reject("unknown-src-type");
  const src = str(raw.src);
  if (!src) return reject("bad-src");

  const fwNum = raw.firmware;
  const fw = typeof fwNum === "number" || typeof fwNum === "string" ? String(fwNum) : undefined;
  const fwSub = str(raw.fw_sub);
  const msgId = str(raw.msg_id);
  const rssi = num(raw.rssi);
  const snr = num(raw.snr);
  const base: DatagramBase = {
    srcType,
    src,
    raw,
    ...(msgId !== undefined ? { msgId } : {}),
    ...(fw !== undefined ? { firmware: `${fw}${fwSub ?? ""}` } : {}),
    ...(rssi !== undefined ? { rssi } : {}),
    ...(snr !== undefined ? { snr } : {}),
  };

  switch (raw.type) {
    case "pos": {
      const lat = num(raw.lat),
        lon = num(raw.long);
      const latDir = raw.lat_dir,
        lonDir = raw.long_dir;
      if (lat === undefined || lon === undefined) return reject("bad-position");
      if ((latDir !== "N" && latDir !== "S") || (lonDir !== "E" && lonDir !== "W")) return reject("bad-position");
      const symbolTable = symbolChar(raw.aprs_symbol_group);
      const symbolCode = symbolChar(raw.aprs_symbol);
      const altRaw = num(raw.alt),
        batt = num(raw.batt),
        hwId = num(raw.hw_id);
      return {
        ok: true,
        datagram: {
          ...base,
          type: "pos",
          lat,
          latDir,
          lon,
          lonDir,
          ...(symbolTable !== undefined ? { symbolTable } : {}),
          ...(symbolCode !== undefined ? { symbolCode } : {}),
          ...(altRaw !== undefined ? { altRaw } : {}),
          ...(batt !== undefined ? { batt } : {}),
          ...(hwId !== undefined ? { hwId } : {}),
        },
      };
    }
    case "msg": {
      const dst = str(raw.dst),
        msg = str(raw.msg);
      if (dst === undefined) return reject("bad-dst");
      if (msg === undefined) return reject("empty-text");
      return { ok: true, datagram: { ...base, type: "msg", dst, text: msg } };
    }
    case "tele": {
      const values: Record<string, number> = {};
      for (const k of TELE_KEYS) {
        const v = num(raw[k]);
        if (v !== undefined) values[k] = v;
      }
      const din = str(raw.din);
      return {
        ok: true,
        datagram: { ...base, type: "tele", values, ...(din && /^[01]{8}$/.test(din) ? { din } : {}) },
      };
    }
    default:
      return reject("unknown-type");
  }
}
