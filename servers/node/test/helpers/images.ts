// SPDX-License-Identifier: AGPL-3.0-or-later
// Images small enough to build by hand that the gateway still reads as whole files of their type.

/**
 * A JPEG of exactly `size` bytes (at least 14): SOI, a scan header, zero-filled entropy data and EOI. It has no
 * metadata, so the gateway stores it byte for byte.
 */
export function jpegOf(size = 64): Uint8Array<ArrayBuffer> {
  const head = [0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const out = new Uint8Array(Math.max(size, head.length + 2));
  out.set(head);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

const pngChunk = (type: string, data: number[]) => [
  ...[0, 0, 0, data.length],
  ...[...type].map((c) => c.charCodeAt(0)),
  ...data,
  ...[0, 0, 0, 0],
];

/** A PNG of the signature, an IHDR, one IDAT and IEND (CRCs left zero: the gateway reads chunks, not pixels). */
export function pngOf(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...pngChunk("IDAT", [1, 2, 3]),
    ...pngChunk("IEND", []),
  ]);
}
