// SPDX-License-Identifier: MIT
// Parser correctness.
import { describe, it, expect } from "vitest";
import { decodeAprs } from "../src/decode.js";
import { encodeAprsPosition } from "../src/encode.js";
import { formatPosition, parsePosition } from "../src/position.js";
import { decodeMicE } from "../src/mice.js";
import { isValidLatLon } from "../src/geo.js";
import { toMgrs } from "../src/mgrs.js";
import { parseCompressed } from "../src/compressed.js";
import { decodeAx25, encodeAx25 } from "../src/ax25.js";

const frame = (payload: string) => ({ src: "OE8APR", dst: "APRS", path: [] as string[], payload, raw: "" });

describe("a non-position object/item is not planted on null island", () => {
  it("omits coords for an object with no fix", () => {
    const d = decodeAprs(frame(";SHORTOBJ *111111z")) as { kind: string; lat?: number; lon?: number };
    expect(d.kind).toBe("object");
    expect(d.lat).toBeUndefined(); // not {lat:0, lon:0} — that would be a phantom station at 0,0
    expect(d.lon).toBeUndefined();
  });

  it("still decodes coords for a positioned object", () => {
    // object format: ';' + 9-char name + '*'/'_' + 7-char timestamp + position
    const d = decodeAprs(frame(";TESTOBJ  *092345z4703.50N/01524.00E-")) as { kind: string; lat?: number };
    expect(d.kind).toBe("object");
    expect(typeof d.lat).toBe("number");
    expect(d.lat).toBeCloseTo(47.0583, 3);
  });
});

describe("the encoder never emits 60.00 minutes", () => {
  it("carries a rounding overflow into degrees (encodeAprsPosition)", () => {
    // 47.99999° → 47°59.9994' rounds to 60.00' → must carry to 48°00.00'
    const p = encodeAprsPosition(47.99999, 15, "/>");
    expect(p).not.toContain("60.00");
    expect(p).toContain("4800.00N");
  });

  it("carries the overflow in formatPosition too", () => {
    const p = formatPosition(47.99999, 15.99999);
    expect(p).not.toContain("60.00");
    expect(p).toContain("4800.00N");
    expect(p).toContain("01600.00E"); // 15.99999 → 16°00.00'
  });

  it("a normal coordinate is unaffected", () => {
    expect(encodeAprsPosition(47.5, 15.5, "/>")).toContain("4730.00N");
  });
});

describe("MGRS band letter is correct in 80–84°", () => {
  it("returns X (not Z) for a latitude in the 72–84° X band", () => {
    const m = toMgrs(82, 10); // inside coverage, in the X band
    expect(m).not.toBe("");
    expect(/\s/.test(m)).toBe(true);
    const band = m.match(/^\d+([C-X])/)?.[1];
    expect(band).toBe("X"); // BANDS[20] is X, not Z
  });

  it("still empty above 84°", () => {
    expect(toMgrs(85, 10)).toBe("");
  });
});

describe("a position outside the globe decodes to no position", () => {
  it("refuses minutes of 60 or more and degrees past ±90 / ±180 in an uncompressed report", () => {
    expect(decodeAprs(frame("!4704.41N/01526.27E>ok")).kind).toBe("position");
    for (const p of [
      "!9530.00N/01526.27E>",
      "!4775.00N/01526.27E>",
      "!4704.41N/01560.00E>",
      "!4704.41N/18500.00E>",
      "!9000.01S/01526.27E>",
    ])
      expect(decodeAprs(frame(p)).kind, p).toBe("other");
    expect(decodeAprs(frame("!9000.00N/18000.00W>")).kind).toBe("position"); // the edges themselves
    expect(parsePosition("!4775.00N/01526.27E>")).toBeNull();
    expect(parsePosition("!9530.00N/01526.27E>")).toBeNull();
    expect(parsePosition("!4704.41N/01526.27E>")).not.toBeNull();
  });

  it("refuses a compressed report that lands past the poles", () => {
    expect(decodeAprs(frame("!/{{{{{{{{>  !")).kind).toBe("other"); // every base-91 digit at its maximum
  });

  it("refuses a MIC-E latitude past 90° or with minutes of 60 or more", () => {
    const info = "`($n\x1e\x1eO>/";
    expect(decodeMicE("SSRUVT", info)).not.toBeNull();
    expect(decodeMicE("YYRUVT", info)).toBeNull(); // 99°
    expect(decodeMicE("SSWUVT", info)).toBeNull(); // 72'
    expect(decodeMicE("SSRUVT", "`($\x10\x1e\x1eO>/")).toBeNull(); // hundredths below zero
  });

  it("isValidLatLon holds the range and refuses what is not a finite number", () => {
    expect(isValidLatLon(47, 15)).toBe(true);
    expect(isValidLatLon(-90, 180)).toBe(true);
    for (const [lat, lon] of [
      [90.01, 0],
      [0, -180.01],
      [NaN, 0],
      [0, Infinity],
      ["47", 15],
      [null, 15],
    ])
      expect(isValidLatLon(lat, lon), `${lat},${lon}`).toBe(false);
  });
});

describe("decoded fields stay within their bounds (cases found by the property tests)", () => {
  it("a Mic-E course past 360° is dropped, and speed and course bytes outside 0x1c–0x7f carry neither", () => {
    const past = decodeMicE("S32U6T", "'4703.500");
    expect(past).not.toBeNull();
    expect(past?.course).toBeUndefined();
    const low = decodeMicE("S32U6T", "`(_f\x01Oj/]");
    expect(low).not.toBeNull();
    expect(low?.course).toBeUndefined();
    expect(low?.speedKn).toBeUndefined();
    expect(decodeMicE("S32U6T", '`(_fn"Oj/]')?.speedKn).toBeGreaterThanOrEqual(0);
  });

  it("a compressed cs pair outside base-91 carries no speed, course or altitude", () => {
    const neg = parseCompressed("/5L!!<*e7>7\u00000");
    expect(neg).not.toBeNull();
    expect(neg?.speedKn).toBeUndefined();
    const huge = parseCompressed("/092340000\u{1f4e1}W");
    expect(huge).not.toBeNull();
    expect(huge?.altitudeM).toBeUndefined();
    expect(parseCompressed("/5L!!<*e7>7P[")?.speedKn).toBeGreaterThanOrEqual(0);
  });

  it("a CSE/SPD course or a wind direction past 360 is dropped", () => {
    const pos = decodeAprs(frame("=4703.50N/01524.00E>490/010")) as { course?: number; speedKn?: number };
    expect(pos.course).toBeUndefined();
    expect(pos.speedKn).toBe(10);
    const wx = decodeAprs(frame("=4703.50N/01524.00E_999/004g005t077")) as { kind: string; windDirDeg?: number };
    expect(wx.kind).toBe("weather");
    expect(wx.windDirDeg).toBeUndefined();
  });

  it("telemetry keeps only finite readings and an exact sequence number", () => {
    const d = decodeAprs(frame(`T#${"9".repeat(400)},1e999,Infinity,3,4,5,1`));
    expect(d).toMatchObject({ kind: "telemetry", analog: [3, 4, 5] });
    expect((d as { seq?: number }).seq).toBeUndefined();
  });

  it("an AX.25 payload byte from 0x80 to 0x9F decodes to the same code point and re-encodes unchanged", () => {
    const bytes = encodeAx25({ src: "OE8APR", dst: "APRS", payload: ">\x80\x9f\xff" });
    const f = decodeAx25(bytes);
    expect(f?.payload).toBe(">\x80\x9f\xff");
    expect(encodeAx25(f!)).toEqual(bytes);
  });
});
