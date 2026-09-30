// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { rsEncode, qrMatrix, qrSvg, qrText, formatInfo, versionInfo } from "../src/qr.js";

describe("QR encoder", () => {
  it("Reed–Solomon matches the ISO/IEC 18004 worked example", () => {
    const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    expect(rsEncode(data, 10)).toEqual([165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  });

  it("builds a square matrix with the three finder patterns + timing", () => {
    const m = qrMatrix("https://aprscaching.net/?cache=AC-0001");
    const n = m.length;
    expect((n - 17) % 4).toBe(0); // valid QR dimension (17 + 4·version)
    const finder = (r0: number, c0: number) =>
      m[r0]!.slice(c0, c0 + 7).every(Boolean) && m[r0 + 6]!.slice(c0, c0 + 7).every(Boolean);
    expect(finder(0, 0)).toBe(true); // top-left
    expect(finder(0, n - 7)).toBe(true); // top-right
    expect(finder(n - 7, 0)).toBe(true); // bottom-left
    expect(m[6]![8]).toBe(true); // timing starts dark
    expect(m[6]![9]).toBe(false); // alternating
  });

  it("renders an SVG with a quiet zone and the requested pixel size", () => {
    const svg = qrSvg("hello", { size: 200 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="200"');
    expect(svg).toContain("<path");
  });

  it("format information matches the standard's level-M code words", () => {
    // ISO/IEC 18004 Table C.1, error correction level M, masks 0–7
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(formatInfo)).toEqual([
      0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001, 0b100000011001110,
      0b100111110010111, 0b100101010100000,
    ]);
  });

  it("version information matches the standard's code words", () => {
    // ISO/IEC 18004 Table D.1
    expect([7, 8, 9].map(versionInfo)).toEqual([0x07c94, 0x085bc, 0x09a99]);
  });

  it("places the format information beside the top-left finder, down column 8 first", () => {
    const m = qrMatrix("hello");
    const n = m.length;
    // both copies carry the same 15 bits: column 8 (rows 0–5, 7, 8) and row 8 (from the right edge)
    const first = [0, 1, 2, 3, 4, 5, 7, 8].map((r) => m[r]![8]);
    const second = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => m[8]![n - 1 - i]);
    expect(first).toEqual(second);
    expect(m[n - 8]![8]).toBe(true); // the dark module
  });

  it("fits a sign-in link on a hotspot address (v7+), with version information and alignment on the timing lines", () => {
    const link = `https://192.168.100.200:8443/auth/email/verify?token=${"0123456789abcdef".repeat(4)}`;
    const m = qrMatrix(link);
    const n = m.length;
    expect((n - 17) / 4).toBeGreaterThanOrEqual(7);
    // the 6×3 version blocks are transposes of each other
    for (let i = 0; i < 18; i++)
      expect(m[Math.floor(i / 3)]![n - 11 + (i % 3)]).toBe(m[n - 11 + (i % 3)]![Math.floor(i / 3)]);
    // an alignment pattern centred on the timing row: dark centre, light ring, dark border
    const c = (n - 17) / 4 === 7 ? 22 : (n - 17) / 4 === 8 ? 24 : 26;
    expect([m[6]![c], m[6]![c - 1], m[6]![c - 2], m[5]![c], m[4]![c]]).toEqual([true, false, true, false, true]);
  });

  it("renders terminal text two module rows per line, with the quiet zone drawn light", () => {
    const t = qrText("hello");
    const lines = t.split("\n");
    const dim = 21 + 8;
    expect(lines).toHaveLength(Math.ceil(dim / 2));
    for (const l of lines) expect([...l]).toHaveLength(dim);
    expect(lines[0]).toBe("█".repeat(dim));
    expect(/^[█▀▄ ]+$/.test(t.replace(/\n/g, ""))).toBe(true);
  });

  it("rejects data beyond the v9-M capacity", () => {
    expect(qrMatrix("x".repeat(180)).length).toBe(17 + 4 * 9);
    expect(() => qrMatrix("x".repeat(181))).toThrow(/too long/);
  });
});
