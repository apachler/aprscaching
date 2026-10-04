// SPDX-License-Identifier: MIT
// LZHUF codec round-trips (oracle-independent, always runs in CI): B0/B1 framing, CRC integrity,
// CRLF normalization, and the FBB CRC-16 vector. Byte-exactness against real FBB lives in
// lzhuf-oracle.test.ts (skips when the compiled oracle isn't present).
import { describe, it, expect } from "vitest";
import {
  lzhufEncodeB0,
  lzhufDecodeB0,
  lzhufEncodeB1,
  lzhufDecodeB1,
  fbbCrc16,
  toCrlf,
  LzhufError,
  LZHUF_MAX_SIZE,
} from "../src/lzhuf.js";

const corpus = [
  "",
  "A",
  "Hello, hello, HELLO packet radio world!",
  "The quick brown fox jumps over the lazy dog. ".repeat(20),
  "a".repeat(3000), // exceeds the 2048 window — exercises ring wraparound
  Array.from({ length: 1024 }, (_, i) => String.fromCharCode(i & 0xff)).join(""), // all byte values
];

describe("LZHUF B0/B1 round-trips", () => {
  for (const [i, text] of corpus.entries()) {
    it(`B0 round-trips corpus ${i} (${text.length} chars)`, () => {
      const raw = new TextEncoder().encode(text);
      const packed = lzhufEncodeB0(raw);
      expect(Array.from(lzhufDecodeB0(packed))).toEqual(Array.from(raw));
      // the 4-byte LE size prefix matches the input length
      expect(packed[0]! | (packed[1]! << 8) | (packed[2]! << 16) | (packed[3]! << 24)).toBe(raw.length);
    });
    it(`B1 round-trips corpus ${i} with a valid CRC`, () => {
      const raw = new TextEncoder().encode(text);
      const packed = lzhufEncodeB1(raw);
      const { data, crcOk } = lzhufDecodeB1(packed);
      expect(crcOk).toBe(true);
      expect(Array.from(data)).toEqual(Array.from(raw));
    });
  }

  it("B1 flags a corrupted body via the CRC", () => {
    const raw = new TextEncoder().encode("integrity matters on a noisy RF link");
    const packed = lzhufEncodeB1(raw);
    packed[packed.length - 1] = (packed[packed.length - 1]! ^ 0xff) & 0xff; // flip a stream byte
    expect(lzhufDecodeB1(packed).crcOk).toBe(false);
  });

  it("CRLF normalization: LF becomes CRLF, lone CR is dropped", () => {
    expect(Array.from(toCrlf("a\nb"))).toEqual([0x61, 0x0d, 0x0a, 0x62]);
    expect(Array.from(toCrlf("a\r\nb"))).toEqual([0x61, 0x0d, 0x0a, 0x62]);
    expect(Array.from(toCrlf("a\rb"))).toEqual([0x61, 0x0d, 0x0a, 0x62]);
  });

  it("uses the FBB TransIt CRC-16 (poly 0x1021, seed 0, MSB-first)", () => {
    // "123456789" is the canonical CRC-16/XMODEM check vector = 0x31C3
    expect(fbbCrc16(new TextEncoder().encode("123456789"))).toBe(0x31c3);
  });

  it("refuses a declared size above the ceiling before decoding", () => {
    const raw = new TextEncoder().encode("a".repeat(5000));
    expect(() => lzhufDecodeB0(lzhufEncodeB0(raw), 4999)).toThrow(LzhufError);
    expect(lzhufDecodeB0(lzhufEncodeB0(raw), 5000)).toHaveLength(5000);
    const huge = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00]);
    expect(() => lzhufDecodeB0(huge)).toThrow(/ceiling/);
    const sizeAndStream = new Uint8Array([0x01, 0x00, 0x10, 0x00]); // LZHUF_MAX_SIZE + 1
    expect(LZHUF_MAX_SIZE + 1).toBe(0x100001);
    const crc = fbbCrc16(sizeAndStream);
    expect(() => lzhufDecodeB1(new Uint8Array([crc & 0xff, crc >> 8, ...sizeAndStream]))).toThrow(LzhufError);
  });

  it("refuses a stream that ends before its declared size", () => {
    const packed = lzhufEncodeB0(new TextEncoder().encode("The quick brown fox jumps over the lazy dog. ".repeat(20)));
    expect(() => lzhufDecodeB0(packed.subarray(0, packed.length - 20))).toThrow(/ends before/);
    expect(() => lzhufDecodeB0(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toThrow(LzhufError); // 64 KiB from nothing
    expect(() => lzhufDecodeB0(new Uint8Array([0x10]))).toThrow(LzhufError); // shorter than its size field
  });

  it("checks the B1 CRC before decompressing", () => {
    const sizeAndStream = new Uint8Array([0x00, 0x00, 0x01, 0x00]); // 64 KiB declared, no stream
    const crc = fbbCrc16(sizeAndStream) ^ 0x0101;
    expect(lzhufDecodeB1(new Uint8Array([crc & 0xff, crc >> 8, ...sizeAndStream]))).toEqual({
      data: new Uint8Array(0),
      crcOk: false,
    });
  });
});
