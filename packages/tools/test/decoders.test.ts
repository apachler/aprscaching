// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  decodeMorse,
  encodeMorse,
  morseFromTiming,
  encodeVaricode,
  decodeVaricode,
  decodeAprsLine,
  decodeAprsText,
  packetDecoderTool,
  PACKET_DECODER,
  ToolHost,
} from "../src/index.js";

describe("CW (Morse) decoder", () => {
  it("decodes dot/dash tokens to text", () => {
    expect(decodeMorse(".... . .-.. .-.. ---")).toBe("HELLO");
    expect(decodeMorse("-.-. --.-  -.. .")).toBe("CQ DE"); // double space = word gap
  });
  it("round-trips through encodeMorse", () => {
    expect(decodeMorse(encodeMorse("CQ DE OE8APR"))).toBe("CQ DE OE8APR");
  });
  it("classifies a keyed on/off envelope into Morse (unit-estimated)", () => {
    // "E T" — dot, letter-gap, dash
    const events = [
      { on: true, ms: 60 },
      { on: false, ms: 200 },
      { on: true, ms: 180 },
    ];
    expect(decodeMorse(morseFromTiming(events))).toBe("ET");
  });
});

describe("PSK31 varicode codec", () => {
  it("round-trips text through the varicode bitstream", () => {
    const bits = encodeVaricode("cq de oe8apr 73");
    expect(/^0{2}[01]+0{2}$/.test(bits)).toBe(true); // idle-framed
    expect(decodeVaricode(bits)).toBe("cq de oe8apr 73");
  });
  it("every varicode is '00'-free and 1-framed (the defining property)", () => {
    const inner = encodeVaricode("The quick brown fox").slice(2, -2);
    for (const code of inner.split("00"))
      if (code) expect(/^1[01]*1$|^1$/.test(code) && !code.includes("00")).toBe(true);
  });
});

describe("packet decoder", () => {
  const LINE = "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.41N/01526.27E>088/036/A=001234Mobile";

  it("decodes the header, the q-construct and the position fields", () => {
    const r = decodeAprsLine(LINE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frame).toMatchObject({ src: "OE8APR-9", dst: "APRS", heardVia: "rf", igateCall: "OE8XXX" });
    expect(r.frame.path).toEqual(["WIDE1-1", "qAR", "OE8XXX"]);
    expect(r.data.kind).toBe("position");
    expect(r.data.lat).toBeCloseTo(47.0735, 3);
  });

  it("says what is wrong with a line that is not TNC2", () => {
    expect(decodeAprsLine("not a frame")).toEqual({ ok: false, error: expect.stringContaining("Not a TNC2") });
    expect(decodeAprsLine("  \n ")).toEqual({ ok: false, error: expect.stringContaining("Paste") });
  });

  it("returns one field per line as a tool decoder", () => {
    const text = decodeAprsText(LINE);
    expect(text.split("\n")[0]).toBe("OE8APR-9 > APRS via WIDE1-1,qAR,OE8XXX");
    expect(text).toContain("type: position");
    expect(text).toContain("heard via: rf (OE8XXX)");
  });

  it("is a built-in tool that contributes the decoder only once enabled", () => {
    const host = new ToolHost();
    host.register(packetDecoderTool());
    expect(host.decoders()).toHaveLength(0);
    host.setEnabled(PACKET_DECODER.tool, true);
    const dec = host.decoders().find((d) => d.id === PACKET_DECODER.decoder);
    expect(dec?.decode(LINE)).toContain("type: position");
  });
});
