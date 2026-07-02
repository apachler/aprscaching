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

const FEND = 0xc0, FESC = 0xdb, TFEND = 0xdc, TFESC = 0xdd;

// ---- KISS framing ----
/** Split a KISS byte stream into raw AX.25 frames (strips the port/type byte + unescapes). */
export function kissFrames(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let cur: number[] | null = null, esc = false;
  for (const b of buf) {
    if (b === FEND) {
      if (cur && cur.length > 1) out.push(Uint8Array.from(cur.slice(1))); // drop the type/port byte
      cur = []; esc = false; continue;
    }
    if (cur === null) continue;
    if (esc) { cur.push(b === TFEND ? FEND : b === TFESC ? FESC : b); esc = false; }
    else if (b === FESC) esc = true;
    else cur.push(b);
  }
  return out;
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
  for (let i = 0; i < 6; i++) { const c = bytes[off + i]! >> 1; if (c !== 0x20) call += String.fromCharCode(c); }
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
  let off = 0, last = false;
  while (!last && off + 7 <= bytes.length && addrs.length < 10) {
    const a = decodeAddr(bytes, off); addrs.push({ call: a.call, repeated: a.repeated }); last = a.last; off += 7;
  }
  if (!last || addrs.length < 2) return null;
  const control = bytes[off]!, pid = bytes[off + 1]!;
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
