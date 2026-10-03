// SPDX-License-Identifier: MIT
/**
 * ax25.ts — AX.25 UI-frame + KISS framing (APRS over RF/TNC). Pure and reversible so the ingest
 * box can decode KISS from a TNC and (later) encode for TX. Reimplemented from the AX.25 v2.2 and
 * KISS specs.
 *
 * AX.25 address: 6 callsign bytes (ASCII << 1) + 1 SSID byte
 *   bit0 = HDLC extension (1 on the final address), bits1-4 = SSID, bits5-6 reserved (1),
 *   bit7 = command/response (dst,src) or has-been-repeated 'H' (digipeaters).
 * UI frame = dst + src + digis... + control(0x03) + pid(0xF0) + info.
 */
import type { ParsedFrame } from "./types.js";

const FEND = 0xc0,
  FESC = 0xdb,
  TFEND = 0xdc,
  TFESC = 0xdd;

// ---- KISS framing ----
/** Split a KISS byte stream into raw AX.25 frames (strips the port/type byte + unescapes). */
export function kissFrames(buf: Uint8Array): Uint8Array[] {
  return kissDecode(buf).map((k) => k.frame);
}

/** One KISS frame: its port (high nibble of the type byte), its command (low nibble; 0 = data) and body. */
export interface KissFrame {
  port: number;
  command: number;
  frame: Uint8Array;
}

/** Split a complete KISS buffer into frames, keeping each one's port and command. */
export function kissDecode(buf: Uint8Array): KissFrame[] {
  return new KissDecoder(Infinity).push(buf);
}

/**
 * Incremental KISS decoder for a byte stream (TCP, serial, BLE). A frame split across reads is held until
 * its closing FEND arrives, whatever frames came before it in the same read. Bytes before the first FEND
 * belong to no frame and are skipped. A frame that grows past `maxBytes` without a closing FEND means the
 * stream is not KISS: it is dropped and counted in `overflows`, so the buffer stays bounded.
 */
export class KissDecoder {
  private cur: number[] | null = null;
  private esc = false;
  overflows = 0;
  constructor(private readonly maxBytes = 64 * 1024) {}

  /** Feed one read; returns the frames it completed. */
  push(chunk: Uint8Array): KissFrame[] {
    const out: KissFrame[] = [];
    for (const b of chunk) {
      if (b === FEND) {
        const cur = this.cur;
        if (cur && cur.length > 1)
          out.push({ port: cur[0]! >> 4, command: cur[0]! & 0x0f, frame: Uint8Array.from(cur.slice(1)) });
        this.cur = [];
        this.esc = false;
        continue;
      }
      if (this.cur === null) continue;
      if (this.esc) {
        this.cur.push(b === TFEND ? FEND : b === TFESC ? FESC : b);
        this.esc = false;
      } else if (b === FESC) this.esc = true;
      else this.cur.push(b);
      if (this.cur.length > this.maxBytes) {
        this.overflows++;
        this.reset();
      }
    }
    return out;
  }

  /** Forget a partial frame (a new connection must not complete the last one's). */
  reset(): void {
    this.cur = null;
    this.esc = false;
  }
}

/** A CRC-16 table, reflected, for polynomial `poly`. */
function crcTable(poly: number, xor = 0): Uint16Array {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    t[i] = c ^ xor;
  }
  return t;
}
/** SMACK: CRC-16 (polynomial 0x8005, reflected), initial value 0. */
const SMACK_TABLE = crcTable(0xa001);
/** FlexNet: the reflected CRC-CCITT table with every entry XORed with 0x0F87, run unreflected from 0xFFFF. */
const FLEX_TABLE = crcTable(0x8408, 0x0f87);

/**
 * A KISS frame with the CRC a SMACK or FlexNet host appends, as the Linux mkiss driver sends while it probes
 * for one: a type byte with bit 7 set carries a SMACK CRC-16, one with bit 5 set a FlexNet CRC, each over the
 * type byte and the frame. Returns the frame with its CRC and flag removed, `null` when a SMACK CRC fails, and
 * the frame unchanged otherwise: a type byte of 0x2n whose FlexNet CRC fails is data on port 2. Pure.
 */
export function kissStripCrc(k: KissFrame): KissFrame | null {
  const type = (k.port << 4) | k.command;
  if (type <= 0x0f || k.frame.length < 2) return k;
  const all = [type, ...k.frame];
  const strip = (t: number): KissFrame => ({ port: t >> 4, command: t & 0x0f, frame: k.frame.slice(0, -2) });
  if (type & 0x80) {
    let crc = 0;
    for (const b of all) crc = (crc >>> 8) ^ SMACK_TABLE[(crc ^ b) & 0xff]!;
    return crc === 0 ? strip(type & ~0x80) : null;
  }
  if (type & 0x20) {
    let crc = 0xffff;
    for (const b of all) crc = ((crc << 8) ^ FLEX_TABLE[((crc >> 8) ^ b) & 0xff]!) & 0xffff;
    if (crc === 0x7070) return strip(type & ~0x20);
  }
  return k;
}

/** Wrap a raw AX.25 frame in a KISS data frame (port 0), escaping FEND/FESC. */
export function kissWrap(ax25: Uint8Array): Uint8Array {
  const out: number[] = [FEND, 0x00];
  for (const b of ax25) {
    if (b === FEND) out.push(FESC, TFEND);
    else if (b === FESC) out.push(FESC, TFESC);
    else out.push(b);
  }
  out.push(FEND);
  return Uint8Array.from(out);
}

// ---- AX.25 address codec ----
function decodeAddr(bytes: Uint8Array, off: number): { call: string; last: boolean; repeated: boolean } {
  let call = "";
  for (let i = 0; i < 6; i++) {
    const c = bytes[off + i]! >> 1;
    if (c !== 0x20) call += String.fromCharCode(c);
  }
  const ssidByte = bytes[off + 6]!;
  const ssid = (ssidByte >> 1) & 0x0f;
  if (ssid) call += `-${ssid}`;
  return { call, last: (ssidByte & 0x01) === 1, repeated: (ssidByte & 0x80) !== 0 };
}
function encodeAddr(callWithSsid: string, last: boolean, cOrH = false): number[] {
  const [base, ssidStr] = callWithSsid.split("-");
  const call = (base ?? "").toUpperCase().slice(0, 6).padEnd(6, " ");
  const ssid = Math.min(15, Math.max(0, Number(ssidStr ?? 0) || 0));
  const out = [...call].map((c) => c.charCodeAt(0) << 1);
  out.push((last ? 0x01 : 0x00) | (ssid << 1) | 0x60 | (cOrH ? 0x80 : 0x00));
  return out;
}

/** Decode a raw AX.25 UI frame into the same shape parseTNC2 produces. null if malformed. */
export function decodeAx25(bytes: Uint8Array): ParsedFrame | null {
  if (bytes.length < 16) return null;
  const addrs: { call: string; repeated: boolean }[] = [];
  let off = 0,
    last = false;
  while (!last && off + 7 <= bytes.length && addrs.length < 10) {
    const a = decodeAddr(bytes, off);
    addrs.push({ call: a.call, repeated: a.repeated });
    last = a.last;
    off += 7;
  }
  if (!last || addrs.length < 2) return null;
  const control = bytes[off]!,
    pid = bytes[off + 1]!;
  if (control !== 0x03 || pid !== 0xf0) return null; // only UI / no-layer-3
  const payload = new TextDecoder("latin1").decode(bytes.slice(off + 2));
  const dst = addrs[0]!.call;
  const src = addrs[1]!.call;
  const path = addrs.slice(2).map((a) => a.call + (a.repeated ? "*" : ""));
  return { src, dst, path, payload, raw: `${src}>${dst}${path.length ? "," + path.join(",") : ""}:${payload}` };
}

/** Encode a frame as a raw AX.25 UI frame (digipeaters carry the repeated '*' as the H-bit). */
export function encodeAx25(f: { src: string; dst: string; path?: string[]; payload: string }): Uint8Array {
  const path = f.path ?? [];
  const bytes: number[] = [];
  bytes.push(...encodeAddr(f.dst, false));
  bytes.push(...encodeAddr(f.src, path.length === 0));
  path.forEach((p, i) => {
    const repeated = p.endsWith("*");
    bytes.push(...encodeAddr(repeated ? p.slice(0, -1) : p, i === path.length - 1, repeated));
  });
  bytes.push(0x03, 0xf0);
  for (const ch of f.payload) bytes.push(ch.charCodeAt(0) & 0xff);
  return Uint8Array.from(bytes);
}
