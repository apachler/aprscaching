// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { decodeAprs, decodeAx25, encodeAx25, rfText } from "../src/index.js";

/** Text as the codec holds the bytes it heard: one character per byte. */
const held = (bytes: number[]) => String.fromCharCode(...bytes);
const utf8 = (text: string) => held([...new TextEncoder().encode(text)]);

describe("rfText", () => {
  it("reads valid UTF-8 as UTF-8", () => {
    expect(rfText(utf8("Grüße"))).toBe("Grüße");
    expect(rfText(utf8("73 de OE8ABC → 5 € 𝄞"))).toBe("73 de OE8ABC → 5 € 𝄞");
  });

  it("keeps bytes that are not valid UTF-8 one character per byte (Latin-1)", () => {
    expect(rfText(held([0x47, 0x72, 0xfc, 0xdf, 0x65]))).toBe("Grüße");
    // a lone lead byte, a truncated sequence and an overlong encoding are not UTF-8
    expect(rfText(held([0x41, 0xc3]))).toBe("AÃ");
    expect(rfText(held([0xe2, 0x82, 0x41]))).toBe("â\u0082A");
    expect(rfText(held([0xc0, 0xaf]))).toBe("À¯");
  });

  it("returns ASCII and text already above U+00FF unchanged", () => {
    expect(rfText("!4703.50N/01242.00E>hello")).toBe("!4703.50N/01242.00E>hello");
    expect(rfText("")).toBe("");
    expect(rfText("Grüße → Ã¼")).toBe("Grüße → Ã¼");
  });

  it("keeps a byte-order mark", () => {
    expect(rfText(utf8("﻿Hallo"))).toBe("﻿Hallo");
  });
});

describe("text heard on RF", () => {
  it("holds the bytes for the air and reads the text for people", () => {
    const sent = utf8(":OE5XYZ   :Grüße{7");
    const frame = decodeAx25(encodeAx25({ src: "OE8ABC-7", dst: "APRS", path: ["WIDE1-1"], payload: sent }))!;
    // the frame keeps the bytes heard, so re-encoding it (IGate, digipeater) sends them unchanged
    expect(frame.payload).toBe(sent);
    expect(encodeAx25(frame)).toEqual(encodeAx25({ src: "OE8ABC-7", dst: "APRS", path: ["WIDE1-1"], payload: sent }));
    const data = decodeAprs({ ...frame, payload: rfText(frame.payload) });
    expect(data).toMatchObject({ kind: "message", addressee: "OE5XYZ", text: "Grüße", msgNo: "7" });
  });
});
