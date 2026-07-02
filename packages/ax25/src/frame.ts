// SPDX-License-Identifier: MIT
/**
 * frame.ts — AX.25 v2.2 frame codec for CONNECTED mode (docs/design/25 P0). Unlike the APRS UI-only path in
 * @aprsweb/aprs, this handles every frame type and the full control field (N(S)/N(R)/P-F), so the
 * LAPB state machine in link.ts can speak real packet. Pure + runtime-neutral. Supports BOTH the
 * modulo-8 control field (1 octet, 3-bit sequence numbers) and — when `extended` is set — the
 * modulo-128 / SABME extended control field (2 octets for I and S frames, 7-bit sequence numbers).
 * The modulo is a per-link property established at connect (SABM ⇒ mod-8, SABME ⇒ mod-128), so the
 * codec cannot infer it from the bytes; the caller passes `extended` to match the link.
 */
export interface Ax25Address { call: string; ssid: number }

export type FrameType =
  | "I" | "RR" | "RNR" | "REJ" | "SREJ"
  | "SABM" | "SABME" | "DISC" | "DM" | "UA" | "FRMR" | "UI" | "XID" | "TEST";

export interface Ax25Frame {
  dst: Ax25Address;
  src: Ax25Address;
  digis?: Ax25Address[];     // via path (each with its has-been-repeated bit on decode)
  digisRepeated?: boolean[]; // parallel to digis: the H (has-been-repeated) bit per via-hop
  command: boolean;          // from the C bits: true = command, false = response (AX.25 v2)
  type: FrameType;
  pf: boolean;               // poll (command) / final (response)
  extended?: boolean;        // set on decode (and by the link on emit) when this is a modulo-128 I/S frame
  nr?: number;               // I + S frames
  ns?: number;               // I frames
  pid?: number;              // I + UI frames (0xF0 = no layer 3)
  info?: Uint8Array;         // I / UI / FRMR / TEST payload
}

export const PID_NO_L3 = 0xf0;
export const PID_NETROM = 0xcf;

// U-frame control values (P/F bit 0x10 masked off)
const U: Record<string, number> = { SABME: 0x6f, SABM: 0x2f, DISC: 0x43, DM: 0x0f, UA: 0x63, FRMR: 0x87, UI: 0x03, XID: 0xaf, TEST: 0xe3 };
const U_REV: Record<number, FrameType> = Object.fromEntries(Object.entries(U).map(([k, v]) => [v, k as FrameType]));
const S_BITS: Record<string, number> = { RR: 0, RNR: 1, REJ: 2, SREJ: 3 };
const S_REV: FrameType[] = ["RR", "RNR", "REJ", "SREJ"];

const PF = 0x10;

// ------------------------------------------------------------------ address
/** Encode one AX.25 address octet-group (7 bytes). `cbit` = the SSID's top bit (C/R or H), `last` = end. */
export function encodeAddress(a: Ax25Address, cbit: boolean, last: boolean): Uint8Array {
  const out = new Uint8Array(7);
  const call = a.call.toUpperCase().slice(0, 6).padEnd(6, " ");
  for (let i = 0; i < 6; i++) out[i] = call.charCodeAt(i) << 1;
  out[6] = (cbit ? 0x80 : 0) | 0x60 | ((a.ssid & 0x0f) << 1) | (last ? 1 : 0); // bits6-5 reserved=1
  return out;
}

/** Decode a 7-byte address; returns the address, its top SSID bit (C/H), and whether it's the last. */
export function decodeAddress(b: Uint8Array, off: number): { addr: Ax25Address; cbit: boolean; last: boolean } {
  let call = "";
  for (let i = 0; i < 6; i++) call += String.fromCharCode(b[off + i]! >> 1);
  const ssidByte = b[off + 6]!;
  return { addr: { call: call.trimEnd(), ssid: (ssidByte >> 1) & 0x0f }, cbit: !!(ssidByte & 0x80), last: !!(ssidByte & 1) };
}

// ------------------------------------------------------------------ frame
/**
 * Serialize an AX.25 frame to bytes. Command/response is carried in the dst/src C bits (v2). When
 * `extended` (modulo-128), I and S frames get a 2-octet control field (7-bit N(S)/N(R)); U frames are
 * unchanged. `extended` defaults to the frame's own `extended` flag so a link can tag what it emits.
 */
export function encodeFrame(f: Ax25Frame, extended = f.extended ?? false): Uint8Array {
  const parts: number[] = [];
  // dst C bit = command, src C bit = !command (AX.25 v2 convention)
  const dst = encodeAddress(f.dst, f.command, false);
  const digis = f.digis ?? [];
  const src = encodeAddress(f.src, !f.command, digis.length === 0);
  parts.push(...dst, ...src);
  digis.forEach((d, i) => parts.push(...encodeAddress(d, f.digisRepeated?.[i] ?? false, i === digis.length - 1)));

  const isI = f.type === "I", isS = S_BITS[f.type] !== undefined;
  if (extended && (isI || isS)) {
    // 16-bit control, low octet first: octet1 carries the type/N(S), octet2 carries P/F + N(R).
    const o1 = isI ? ((f.ns! & 0x7f) << 1) : (0b01 | (S_BITS[f.type]! << 2));
    const o2 = ((f.nr! & 0x7f) << 1) | (f.pf ? 1 : 0);
    parts.push(o1, o2);
  } else {
    let ctrl: number;
    if (isI) ctrl = ((f.nr! & 7) << 5) | (f.pf ? PF : 0) | ((f.ns! & 7) << 1);
    else if (isS) ctrl = ((f.nr! & 7) << 5) | (f.pf ? PF : 0) | (S_BITS[f.type]! << 2) | 0b01;
    else ctrl = U[f.type]! | (f.pf ? PF : 0);
    parts.push(ctrl);
  }

  if (f.type === "I" || f.type === "UI") parts.push(f.pid ?? PID_NO_L3);
  if (f.info && (f.type === "I" || f.type === "UI" || f.type === "FRMR" || f.type === "TEST")) parts.push(...f.info);
  return Uint8Array.from(parts);
}

/**
 * Parse bytes into an AX.25 frame, or null if malformed. Pass `extended` (modulo-128) to read the 2-octet
 * I/S control field — the caller knows the link's modulo from the connect (SABM vs SABME); the bytes don't.
 */
export function decodeFrame(bytes: Uint8Array, extended = false): Ax25Frame | null {
  if (bytes.length < 15) return null;                       // 2 addresses + control minimum
  const addrs: { addr: Ax25Address; cbit: boolean; last: boolean }[] = [];
  let off = 0;
  for (let n = 0; n < 10; n++) {                            // dst, src, up to 8 digis
    if (off + 7 > bytes.length) return null;
    const a = decodeAddress(bytes, off); addrs.push(a); off += 7;
    if (a.last) break;
  }
  if (addrs.length < 2) return null;
  const [dst, src, ...digis] = addrs;
  const command = dst!.cbit;                                // v2: dst C bit set ⇒ command

  const ctrl = bytes[off++]!;
  let pf = !!(ctrl & PF), isExt = false;
  let type: FrameType, nr: number | undefined, ns: number | undefined, pid: number | undefined, info: Uint8Array | undefined;

  if ((ctrl & 1) === 0) {                                   // I frame
    type = "I";
    if (extended) { const c2 = bytes[off++]!; isExt = true; ns = (ctrl >> 1) & 0x7f; nr = (c2 >> 1) & 0x7f; pf = !!(c2 & 1); }
    else { nr = (ctrl >> 5) & 7; ns = (ctrl >> 1) & 7; }
    pid = bytes[off++]; info = bytes.subarray(off);
  } else if ((ctrl & 0b11) === 0b01) {                      // S frame
    type = S_REV[(ctrl >> 2) & 3]!;
    if (extended) { const c2 = bytes[off++]!; isExt = true; nr = (c2 >> 1) & 0x7f; pf = !!(c2 & 1); }
    else { nr = (ctrl >> 5) & 7; }
  } else {                                                  // U frame (always 1 octet, even in extended mode)
    const base = ctrl & ~PF;
    type = U_REV[base] ?? "DM";
    if (type === "UI") { pid = bytes[off++]; info = bytes.subarray(off); }
    else if (type === "FRMR" || type === "TEST") info = bytes.subarray(off);
  }
  return {
    dst: dst!.addr, src: src!.addr,
    digis: digis.length ? digis.map((d) => d.addr) : undefined,
    digisRepeated: digis.length ? digis.map((d) => d.cbit) : undefined,
    command, type, pf, nr, ns, pid, info: info && info.length ? info : undefined,
    ...(isExt ? { extended: true } : {}),
  };
}

/** Format an address as CALL or CALL-SSID. */
export const addrStr = (a: Ax25Address): string => (a.ssid ? `${a.call}-${a.ssid}` : a.call);
/** Parse "CALL" / "CALL-SSID" into an address. */
export function parseAddr(s: string): Ax25Address {
  const [call, ssid] = s.toUpperCase().split("-");
  return { call: call ?? "", ssid: ssid ? Math.max(0, Math.min(15, parseInt(ssid, 10) || 0)) : 0 };
}
export const sameAddr = (a: Ax25Address, b: Ax25Address): boolean => a.call === b.call && a.ssid === b.ssid;
