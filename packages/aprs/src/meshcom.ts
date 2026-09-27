// SPDX-License-Identifier: MIT
/**
 * meshcom.ts — parse a MeshCom node's external-UDP JSON datagram (port 1799, enabled on the node with
 * `--extudp on`) into an APRS-normalised frame. Pure; the UDP socket lives in apps/ingest.
 *
 * The field contract follows the MeshCom firmware (MIT, icssw-org/MeshCom-Firmware,
 * `src/extudp_functions.cpp`):
 *   pos: { src_type, type:"pos", src, lat, lat_dir, long, long_dir, aprs_symbol, aprs_symbol_group,
 *          msg_id, alt, batt, hw_id, firmware, fw_sub, rssi, snr }
 *   msg: { src_type, type:"msg", src, dst, msg, msg_id, firmware, fw_sub, rssi, snr }
 * `src` is the source path: the originating call first, then each relaying node. `lat`/`long` are
 * unsigned degrees with the hemisphere in `lat_dir`/`long_dir`. `src_type` says where the node got the
 * frame: `lora` (on air), `udp` (relayed by the MeshCom server over the internet), `node` (the node
 * itself). None of these is authenticated, so the caller treats every frame as Tier C.
 *
 * `alt` is omitted: the firmware copies the raw `/A=` digits, which are feet or metres depending on a
 * per-node setting, so the unit is unknowable from the datagram.
 */

export type MeshcomSrcType = "lora" | "udp" | "node";

export interface MeshcomFrame {
  srcType: MeshcomSrcType;
  /** position = a fix; message = a direct message to a callsign; group = group or `*` broadcast text. */
  kind: "position" | "message" | "group";
  src: string;
  /** Relaying nodes after the originator, in path order. */
  relays: string[];
  /** Addressee callsign (message) or group number / `*` (group). */
  dst?: string;
  /** APRS information field the gateway decodes like any other frame. */
  payload: string;
  /** The MeshCom frame id (8 hex digits) — the same on every copy of one frame, so it dedupes. */
  msgId?: string;
  lat?: number;
  lon?: number;
  rssi?: number;
  snr?: number;
}

/** Datagrams larger than this are not MeshCom output (the firmware's JSON buffer is 500 bytes). */
export const MESHCOM_MAX_DATAGRAM = 1024;

/** MeshCom text is at most 150 characters; a little slack absorbs multi-byte UTF-8. */
const MAX_TEXT = 200;

/**
 * An amateur callsign with an optional SSID. MeshCom SSIDs run past the AX.25 0–15 range (`-99`),
 * as APRS-IS text calls do; the base call must hold both a letter and a digit, which keeps out group
 * numbers and non-call tokens such as the firmware's internal `HOME` source.
 */
const CALL = /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,7}(?:-[A-Z0-9]{1,2})?$/;
const isCall = (s: string) => s.length <= 9 && CALL.test(s);

const GROUP = /^(?:\*|\d{1,5})$/;
const MSG_ID = /^[0-9A-F]{1,8}$/i;

/** Printable ASCII only, for a single APRS symbol character. */
const symbolChar = (v: unknown): string | undefined => {
  if (typeof v !== "string" || v.length === 0) return undefined;
  const c = v[0]!; // the firmware doubles a backslash table/code, so the first char is the symbol
  const code = c.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e ? c : undefined;
};

/** Collapse control characters so a text payload stays one APRS line. */
const oneLine = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Uncompressed APRS `DDMM.mm` / `DDDMM.mm`, carrying a 60.00' rounding overflow into degrees. */
function dm(v: number, width: number): string {
  let d = Math.floor(v);
  let cm = Math.round((v - d) * 6000);
  if (cm >= 6000) {
    d += 1;
    cm -= 6000;
  }
  return `${String(d).padStart(width, "0")}${(cm / 100).toFixed(2).padStart(5, "0")}`;
}

function parsePos(o: Record<string, unknown>): { payload: string; lat: number; lon: number } | null {
  const la = finite(o.lat),
    lo = finite(o.long);
  const ns = o.lat_dir,
    ew = o.long_dir;
  if (la === undefined || lo === undefined) return null;
  if (ns !== "N" && ns !== "S") return null;
  if (ew !== "E" && ew !== "W") return null;
  if (la < 0 || la > 90 || lo < 0 || lo > 180) return null;
  if (la === 0 && lo === 0) return null; // a node without a fix reports 0/0
  const table = symbolChar(o.aprs_symbol_group) ?? "/";
  const code = symbolChar(o.aprs_symbol) ?? ">";
  return {
    payload: `!${dm(la, 2)}${ns}${table}${dm(lo, 3)}${ew}${code}`,
    lat: ns === "S" ? -la : la,
    lon: ew === "W" ? -lo : lo,
  };
}

/** Parse one external-UDP datagram. Returns null for anything that is not a well-formed pos/msg frame. */
export function parseMeshcomUdp(input: string | Uint8Array): MeshcomFrame | null {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  if (text.length > MESHCOM_MAX_DATAGRAM) return null;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;

  const srcType = r.src_type;
  if (srcType !== "lora" && srcType !== "udp" && srcType !== "node") return null;
  if (typeof r.src !== "string") return null;
  const hops = r.src
    .toUpperCase()
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length === 0 || hops.length > 9 || !hops.every(isCall)) return null;
  const [src, ...relays] = hops as [string, ...string[]];

  const base: Omit<MeshcomFrame, "kind" | "payload"> = {
    srcType,
    src,
    relays,
    ...(typeof r.msg_id === "string" && MSG_ID.test(r.msg_id) ? { msgId: r.msg_id.toUpperCase() } : {}),
    ...(finite(r.rssi) !== undefined ? { rssi: finite(r.rssi) } : {}),
    ...(finite(r.snr) !== undefined ? { snr: finite(r.snr) } : {}),
  };

  if (r.type === "pos") {
    const pos = parsePos(r);
    if (!pos) return null;
    return { ...base, kind: "position", payload: pos.payload, lat: pos.lat, lon: pos.lon };
  }

  if (r.type === "msg") {
    if (typeof r.dst !== "string" || typeof r.msg !== "string") return null;
    const dst = r.dst.split(",")[0]!.trim().toUpperCase();
    const body = oneLine(r.msg);
    if (!body) return null;
    if (isCall(dst)) {
      // APRS message: `:ADDRESSEE:text{msgNo`. MeshCom already carries the APRS `{nnn` suffix in `msg`.
      return { ...base, kind: "message", dst, payload: `:${dst.padEnd(9, " ")}:${body}` };
    }
    if (GROUP.test(dst)) {
      // Group and broadcast chatter is not addressed to a station, so it must not land in the
      // messages log. It travels as an APRS user-defined packet (`{` + user id `M` + type `G`),
      // which the decoder classifies as `other`: visible in the port monitor, nowhere else.
      return { ...base, kind: "group", dst, payload: `{MG${dst}:${body}` };
    }
    return null;
  }

  return null;
}
