import { describe, it, expect } from "vitest";
import { toAnsi, cp437Bytes, parseAnsi, stripAnsi } from "../src/index.js";

const ESC = "\x1b";

describe("toAnsi", () => {
  it("wraps each row in reset + CRLF and applies a default fg", () => {
    const out = toAnsi(["hi"], { fg: 10 });
    expect(out).toBe(`${ESC}[0m${ESC}[92mhi${ESC}[0m\r\n`);
  });

  it("emits SGR for per-segment fg/bg/bold and coalesces nothing it isn't given", () => {
    const out = toAnsi([[{ text: "A", fg: 1, bold: true }, { text: "B", bg: 4 }]]);
    expect(out).toContain(`${ESC}[1;31mA`);   // bold + red fg
    expect(out).toContain(`${ESC}[44mB`);     // blue bg
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("round-trips through the parser: exported colour spans parse back to the same attributes", () => {
    const ansi = toAnsi([[{ text: "OE8APR", fg: 10, bold: true }, { text: " de ", fg: 7 }]]);
    const spans = parseAnsi(ansi).filter((s) => s.text.trim() !== "");
    expect(spans[0]).toMatchObject({ text: "OE8APR", fg: 10, bold: true });
    expect(stripAnsi(ansi).trim()).toBe("OE8APR de");
  });
});

describe("cp437Bytes", () => {
  it("passes ASCII + ESC/CR/LF through unchanged", () => {
    expect(Array.from(cp437Bytes("A\x1b[0m\r\n"))).toEqual([0x41, 0x1b, 0x5b, 0x30, 0x6d, 0x0d, 0x0a]);
  });
  it("maps box-drawing + block + marker glyphs to their CP437 code point", () => {
    expect(Array.from(cp437Bytes("┌─┐│└┘"))).toEqual([0xda, 0xc4, 0xbf, 0xb3, 0xc0, 0xd9]);
    expect(Array.from(cp437Bytes("█▓▒░"))).toEqual([0xdb, 0xb2, 0xb1, 0xb0]);
    expect(Array.from(cp437Bytes("●◆▲→"))).toEqual([0x07, 0x04, 0x1e, 0x1a]);
  });
  it("degrades unmapped non-ASCII to '?'", () => {
    expect(Array.from(cp437Bytes("📻"))).toEqual([0x3f]);
  });
});
