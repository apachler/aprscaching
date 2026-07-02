// SPDX-License-Identifier: MIT
/**
 * agwpe.ts — the AGW Packet Engine (AGWPE) frame codec (docs/design/27 B.1). AGWPE is the de-facto TCP TNC
 * protocol spoken by Direwolf, SoundModem and UZ7HO — the single highest-leverage interop after KISS,
 * letting any AGWPE modem feed us (and us key it) over a socket. This is the pure wire codec (a fixed
 * 36-byte little-endian header + payload); the TCP client that uses it lives in apps/ingest and is
 * validated at deploy against a real engine.
 */
export interface AgwpeFrame {
  port: number;        // radio port (Multiport)
  kind: string;        // DataKind, a single ASCII char ('K' raw AX.25, 'V' UI, 'D' conn data, …)
  pid: number;
  from: string;        // CallFrom (≤9 chars)
  to: string;          // CallTo
  data: Uint8Array;
}

const HEADER = 36;
const putAscii = (view: Uint8Array, off: number, s: string, len: number) => {
  for (let i = 0; i < len; i++) view[off + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
};
const getAscii = (view: Uint8Array, off: number, len: number) => {
  let s = ""; for (let i = 0; i < len; i++) { const c = view[off + i]!; if (c === 0) break; s += String.fromCharCode(c); } return s;
};

/** Encode one AGWPE frame to bytes (header + data). */
export function encodeAgwpe(f: Partial<AgwpeFrame> & { kind: string }): Uint8Array {
  const data = f.data ?? new Uint8Array(0);
  const out = new Uint8Array(HEADER + data.length);
  const dv = new DataView(out.buffer);
  out[0] = f.port ?? 0;
  out[4] = f.kind.charCodeAt(0) & 0xff;
  out[6] = f.pid ?? 0;
  putAscii(out, 8, (f.from ?? "").toUpperCase(), 10);
  putAscii(out, 18, (f.to ?? "").toUpperCase(), 10);
  dv.setUint32(28, data.length, true);   // DataLen, little-endian
  // bytes 32..35 (User) left 0
  out.set(data, HEADER);
  return out;
}

/**
 * Parse as many complete AGWPE frames as `buf` contains; return them plus any trailing partial bytes
 * (the caller re-feeds `rest` with the next chunk). Tolerant of a stream split mid-frame.
 */
export function parseAgwpe(buf: Uint8Array): { frames: AgwpeFrame[]; rest: Uint8Array } {
  const frames: AgwpeFrame[] = [];
  let off = 0;
  while (buf.length - off >= HEADER) {
    const dv = new DataView(buf.buffer, buf.byteOffset + off);
    const dataLen = dv.getUint32(28, true);
    if (buf.length - off - HEADER < dataLen) break;        // wait for the full payload
    frames.push({
      port: buf[off]!,
      kind: String.fromCharCode(buf[off + 4]!),
      pid: buf[off + 6]!,
      from: getAscii(buf, off + 8, 10),
      to: getAscii(buf, off + 18, 10),
      data: buf.slice(off + HEADER, off + HEADER + dataLen),
    });
    off += HEADER + dataLen;
  }
  return { frames, rest: buf.slice(off) };
}
