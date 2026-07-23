// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { catSetFrequency, catSetMode, APRS_FREQ } from "../src/index.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (b: Uint8Array) => new TextDecoder().decode(b);

describe("cat — set frequency", () => {
  it("Kenwood ASCII FA + 11 digits + ; (EU APRS 144.800)", () => {
    expect(ascii(catSetFrequency("kenwood", APRS_FREQ.eu))).toBe("FA00144800000;");
    expect(ascii(catSetFrequency("kenwood", 14_074_000))).toBe("FA00014074000;");
  });

  it("Icom CI-V FE FE <addr> E0 05 <freq BCD LE> FD (IC-7300 @0x94)", () => {
    expect(hex(catSetFrequency("icom", APRS_FREQ.eu))).toBe("fe fe 94 e0 05 00 00 80 44 01 fd");
    expect(hex(catSetFrequency("icom", APRS_FREQ.na, { icomAddr: 0xa4 }))).toBe("fe fe a4 e0 05 00 00 39 44 01 fd");
  });

  it("classic Yaesu binary: 4 BCD bytes (10 Hz units) + 0x01 opcode", () => {
    expect(hex(catSetFrequency("yaesu-bin", APRS_FREQ.eu))).toBe("14 48 00 00 01");
    expect(hex(catSetFrequency("yaesu-bin", 7_074_000))).toBe("00 70 74 00 01");
  });
});

describe("cat — set mode", () => {
  it("maps spot mode spellings to Kenwood + Icom codes", () => {
    expect(ascii(catSetMode("kenwood", "FM")!)).toBe("MD4;");
    expect(ascii(catSetMode("kenwood", "usb")!)).toBe("MD2;");
    expect(hex(catSetMode("icom", "FM")!)).toBe("fe fe 94 e0 06 05 fd");
    expect(catSetMode("yaesu-bin", "FM")).toBeNull(); // opcode varies per classic model
    expect(catSetMode("kenwood", "bogus")).toBeNull();
  });
});
