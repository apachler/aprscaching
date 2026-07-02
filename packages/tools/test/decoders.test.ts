// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { decodeMorse, encodeMorse, morseFromTiming, encodeVaricode, decodeVaricode } from "../src/index.js";

describe("CW (Morse) decoder (F-5)", () => {
  it("decodes dot/dash tokens to text", () => {
    expect(decodeMorse(".... . .-.. .-.. ---")).toBe("HELLO");
    expect(decodeMorse("-.-. --.-  -.. .")).toBe("CQ DE"); // double space = word gap
  });
  it("round-trips through encodeMorse", () => {
    expect(decodeMorse(encodeMorse("CQ DE OE8APR"))).toBe("CQ DE OE8APR");
  });
  it("classifies a keyed on/off envelope into Morse (unit-estimated)", () => {
    // "E T" — dot, letter-gap, dash
    const events = [{ on: true, ms: 60 }, { on: false, ms: 200 }, { on: true, ms: 180 }];
    expect(decodeMorse(morseFromTiming(events))).toBe("ET");
  });
});

describe("PSK31 varicode codec (F-5)", () => {
  it("round-trips text through the varicode bitstream", () => {
    const bits = encodeVaricode("cq de oe8apr 73");
    expect(/^0{2}[01]+0{2}$/.test(bits)).toBe(true);   // idle-framed
    expect(decodeVaricode(bits)).toBe("cq de oe8apr 73");
  });
  it("every varicode is '00'-free and 1-framed (the defining property)", () => {
    const inner = encodeVaricode("The quick brown fox").slice(2, -2);
    for (const code of inner.split("00")) if (code) expect(/^1[01]*1$|^1$/.test(code) && !code.includes("00")).toBe(true);
  });
});
