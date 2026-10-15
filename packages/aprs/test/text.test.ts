// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  decodeAprs,
  decodeAx25,
  encodeAprsMessage,
  encodeAprsPosition,
  encodeAx25,
  rfByteLength,
  rfBytes,
  rfClip,
  rfText,
} from "../src/index.js";

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

describe("rfBytes", () => {
  it("holds originated text as its UTF-8 bytes, one character per byte", () => {
    expect(rfBytes("Grüße")).toBe(held([0x47, 0x72, 0xc3, 0xbc, 0xc3, 0x9f, 0x65]));
    expect(rfBytes("5 € 𝄞")).toBe(utf8("5 € 𝄞"));
  });

  it("returns ASCII unchanged, so encoding it twice changes nothing", () => {
    const info = ":OE5XYZ   :73 de OE8ABC{12";
    expect(rfBytes(info)).toBe(info);
    expect(rfBytes(rfBytes(info))).toBe(info);
  });

  it("is the inverse of rfText for valid UTF-8", () => {
    for (const t of ["Grüße", "Привет", "73 → 𝄞", "ÄÖÜ äöü ß"]) expect(rfText(rfBytes(t))).toBe(t);
  });
});

describe("rfByteLength and rfClip", () => {
  it("count the UTF-8 bytes, not the characters", () => {
    expect(rfByteLength("abc")).toBe(3);
    expect(rfByteLength("ü")).toBe(2);
    expect(rfByteLength("€")).toBe(3);
    expect(rfByteLength("𝄞")).toBe(4);
    expect(rfByteLength("Grüße")).toBe(rfBytes("Grüße").length);
  });

  it("cuts between characters, never inside one", () => {
    expect(rfClip("Grüße", 3)).toBe("Gr");
    expect(rfClip("Grüße", 4)).toBe("Grü");
    expect(rfClip("a𝄞b", 4)).toBe("a");
    expect(rfClip("a𝄞b", 5)).toBe("a𝄞");
    expect(rfClip("abc", 10)).toBe("abc");
    expect(rfClip("abc", 0)).toBe("");
  });
});

describe("text sent on RF", () => {
  it("goes out as UTF-8 and reads back as the text sent", () => {
    const info = encodeAprsMessage("OE5XYZ", "Grüße aus Graz", "7");
    const bytes = encodeAx25({ src: "OE8ABC-7", dst: "APZACG", path: ["WIDE1-1"], payload: rfBytes(info) });
    const wire = new TextEncoder().encode(":OE5XYZ   :Grüße aus Graz{7");
    expect([...bytes.subarray(bytes.length - wire.length)]).toEqual([...wire]);
    const frame = decodeAx25(bytes)!;
    expect(decodeAprs({ ...frame, payload: rfText(frame.payload) })).toMatchObject({
      kind: "message",
      text: "Grüße aus Graz",
      msgNo: "7",
    });
  });

  it("caps a message's text at 67 bytes, without splitting a character", () => {
    const info = encodeAprsMessage("OE5XYZ", "ü".repeat(40), "12");
    const text = info.slice(11, info.indexOf("{"));
    expect(text).toBe("ü".repeat(33));
    expect(rfByteLength(text)).toBe(66);
    expect(info.endsWith("{12")).toBe(true);
    expect(encodeAprsMessage("OE5XYZ", "a".repeat(80)).length).toBe(11 + 67);
  });

  it("caps a position comment at 43 bytes", () => {
    const info = encodeAprsPosition(47, 15, "/>", "€".repeat(20));
    expect(info.endsWith("€".repeat(14))).toBe(true);
    expect(rfByteLength(info.slice(20))).toBe(42);
  });
});
