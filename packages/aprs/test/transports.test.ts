// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { encodeAx25, decodeAx25, kissWrap, kissFrames, formatPosition, decodeAprs } from "../src/index.js";

describe("AX.25 + KISS", () => {
  it("round-trips a UI frame through encode/decode", () => {
    const f = { src: "OE8APR-9", dst: "APRS", path: ["WIDE1-1", "WIDE2-1"], payload: "!4704.41N/01526.27E>hi" };
    const d = decodeAx25(encodeAx25(f))!;
    expect(d.src).toBe("OE8APR-9");
    expect(d.dst).toBe("APRS");
    expect(d.path).toEqual(["WIDE1-1", "WIDE2-1"]);
    expect(d.payload).toBe("!4704.41N/01526.27E>hi");
  });
  it("preserves a has-been-repeated digipeater mark", () => {
    const d = decodeAx25(encodeAx25({ src: "N0CALL", dst: "APRS", path: ["OE8XXX*"], payload: ">test" }))!;
    expect(d.path).toEqual(["OE8XXX*"]);
  });
  it("survives KISS wrap/unwrap with escaping", () => {
    const ax = encodeAx25({ src: "OE8APR", dst: "APRS", path: [], payload: "data\xc0\xdb edge" });
    const frames = kissFrames(kissWrap(ax));
    expect(frames.length).toBe(1);
    const d = decodeAx25(frames[0]!)!;
    expect(d.src).toBe("OE8APR");
    expect(d.payload).toBe("data\xc0\xdb edge");
  });
  it("rejects a non-UI frame", () => {
    const ax = encodeAx25({ src: "A", dst: "B", path: [], payload: "x" });
    ax[14] = 0x00; // clobber the control byte (UI = 0x03)
    expect(decodeAx25(ax)).toBeNull();
  });
});

describe("formatPosition (Meshtastic normalisation)", () => {
  it("round-trips through the decoder", () => {
    const payload = formatPosition(47.0735, 15.4378, {
      code: ">",
      course: 88,
      speedKn: 36,
      altitudeM: 376,
      comment: " test",
    });
    const d = decodeAprs({ src: "X", dst: "APRS", path: [], payload, raw: "" }) as any;
    expect(d.kind).toBe("position");
    expect(d.lat).toBeCloseTo(47.0735, 3);
    expect(d.lon).toBeCloseTo(15.4378, 3);
    expect(d.course).toBe(88);
    expect(d.speedKn).toBe(36);
    expect(d.altitudeM).toBeCloseTo(376, 0);
  });
});
