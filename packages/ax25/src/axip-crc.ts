// SPDX-License-Identifier: MIT
/**
 * axip-crc.ts — the AXIP/AXUDP encapsulation trailer. RFC 1226 (and its living implementations:
 * ax25ipd, JNOS, BPQ's BPQAXIP driver) wraps each AX.25 frame in an IP or UDP datagram and appends
 * the frame's CRC-16/X-25 — the AX.25 FCS polynomial — low byte first. Peers DISCARD frames whose
 * trailer doesn't verify, so emitting it is required for interop, not optional. Pure + runtime-neutral.
 */

/** CRC-16/X-25: reflected polynomial 0x1021 (→ 0x8408), init 0xFFFF, final complement. */
export function crc16X25(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

/** Append the RFC 1226 CRC trailer (CRC-16/X-25, low byte first) to an encapsulated AX.25 frame. */
export function appendAxipCrc(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length + 2);
  out.set(frame);
  const crc = crc16X25(frame);
  out[frame.length] = crc & 0xff;
  out[frame.length + 1] = crc >>> 8;
  return out;
}

/**
 * Validate-and-strip the RFC 1226 CRC trailer from an inbound encapsulation datagram. When the last
 * two bytes verify as the CRC of the rest, return the bare frame; otherwise return the datagram
 * unchanged — a peer sending bare frames (no trailer) still decodes, so both dialects are accepted.
 */
export function stripAxipCrc(datagram: Uint8Array): Uint8Array {
  if (datagram.length > 2) {
    const body = datagram.subarray(0, datagram.length - 2);
    const crc = crc16X25(body);
    if (datagram[datagram.length - 2] === (crc & 0xff) && datagram[datagram.length - 1] === crc >>> 8) return body;
  }
  return datagram;
}
