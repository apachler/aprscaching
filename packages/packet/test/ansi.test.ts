// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseAnsi, stripAnsi } from "../src/index.js";

const E = "\x1b";

describe("ANSI-subset parser (docs/27)", () => {
  it("parses SGR colour + bold and coalesces unstyled text", () => {
    const spans = parseAnsi(`plain ${E}[31mred${E}[1m bold-red${E}[0m back`);
    expect(spans).toEqual([
      { text: "plain ", fg: null, bg: null, bold: false },
      { text: "red", fg: 1, bg: null, bold: false },
      { text: " bold-red", fg: 1, bg: null, bold: true },
      { text: " back", fg: null, bg: null, bold: false },
    ]);
  });

  it("handles bright fg/bg and default resets", () => {
    const s = parseAnsi(`${E}[92m${E}[44mx${E}[39my${E}[49mz`);
    expect(s).toEqual([
      { text: "x", fg: 10, bg: 4, bold: false },
      { text: "y", fg: null, bg: 4, bold: false },
      { text: "z", fg: null, bg: null, bold: false },
    ]);
  });

  it("drops non-SGR control sequences (cursor moves, clears) safely", () => {
    expect(stripAnsi(`a${E}[2Jb${E}[10;5Hc${E}[Kd`)).toBe("abcd");
    expect(stripAnsi(`keep${E}broken`)).toBe("keepbroken"); // bare ESC dropped
  });

  it("empty SGR (ESC[m) resets like ESC[0m", () => {
    const s = parseAnsi(`${E}[31mr${E}[mn`);
    expect(s[1]).toEqual({ text: "n", fg: null, bg: null, bold: false });
  });
});
