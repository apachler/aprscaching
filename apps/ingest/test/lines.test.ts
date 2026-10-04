// SPDX-License-Identifier: AGPL-3.0-or-later
// The APRS-IS line splitter holds a partial line across chunks, but never past its cap.
import { describe, it, expect } from "vitest";
import { LineBuffer } from "../src/lines.js";

describe("LineBuffer", () => {
  it("joins a line split across chunks and strips CR/LF", () => {
    const b = new LineBuffer();
    expect(b.push("OE8APR>APRS:>hel")).toEqual([]);
    expect(b.push("lo\r\n# keepalive\r\nN0")).toEqual(["OE8APR>APRS:>hello", "# keepalive"]);
    expect(b.push("CALL>APRS:>x\n")).toEqual(["N0CALL>APRS:>x"]);
  });

  it("drops a partial line that outgrows the cap, up to its newline, and keeps the next line", () => {
    const b = new LineBuffer(16);
    expect(b.push("x".repeat(10))).toEqual([]);
    expect(b.push("x".repeat(10))).toEqual([]); // over the cap: the held part is dropped
    expect(b.push("x".repeat(100))).toEqual([]); // still the same line: discarded as it arrives
    expect(b.push("tail\nOK>APRS:>1\n")).toEqual(["OK>APRS:>1"]);
    expect(b.dropped).toBe(1);
  });

  it("drops a complete line longer than the cap", () => {
    const b = new LineBuffer(8);
    expect(b.push("123456789\nshort\n")).toEqual(["short"]);
    expect(b.dropped).toBe(1);
  });

  it("forgets the partial line on reset", () => {
    const b = new LineBuffer();
    b.push("half a li");
    b.reset();
    expect(b.push("ne\n")).toEqual(["ne"]);
  });
});
