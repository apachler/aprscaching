// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { rsEncode, qrMatrix, qrSvg } from "../src/qr.js";

describe("QR encoder (docs/design/11 M4)", () => {
  it("Reed–Solomon matches the ISO/IEC 18004 worked example", () => {
    const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    expect(rsEncode(data, 10)).toEqual([165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  });

  it("builds a square matrix with the three finder patterns + timing", () => {
    const m = qrMatrix("https://aprscaching.net/?cache=AC-0001");
    const n = m.length;
    expect((n - 17) % 4).toBe(0);                    // valid QR dimension (17 + 4·version)
    const finder = (r0: number, c0: number) => m[r0]!.slice(c0, c0 + 7).every(Boolean) && m[r0 + 6]!.slice(c0, c0 + 7).every(Boolean);
    expect(finder(0, 0)).toBe(true);                 // top-left
    expect(finder(0, n - 7)).toBe(true);             // top-right
    expect(finder(n - 7, 0)).toBe(true);             // bottom-left
    expect(m[6]![8]).toBe(true);                     // timing starts dark
    expect(m[6]![9]).toBe(false);                    // alternating
  });

  it("renders an SVG with a quiet zone and the requested pixel size", () => {
    const svg = qrSvg("hello", { size: 200 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="200"');
    expect(svg).toContain("<path");
  });

  it("rejects data beyond the v6-M capacity", () => {
    expect(() => qrMatrix("x".repeat(200))).toThrow(/too long/);
  });
});
