// SPDX-License-Identifier: MIT
// P2d parser correctness — SR-PARSE-03/04/06.
import { describe, it, expect } from "vitest";
import { decodeAprs } from "../src/decode.js";
import { encodeAprsPosition } from "../src/encode.js";
import { formatPosition } from "../src/position.js";
import { toMgrs } from "../src/mgrs.js";

const frame = (payload: string) => ({ src: "OE8APR", dst: "APRS", path: [] as string[], payload, raw: "" });

describe("SR-PARSE-03 — a non-position object/item is not planted on null island", () => {
  it("omits coords for an object with no fix", () => {
    const d = decodeAprs(frame(";SHORTOBJ *111111z")) as { kind: string; lat?: number; lon?: number };
    expect(d.kind).toBe("object");
    expect(d.lat).toBeUndefined(); // was {lat:0, lon:0} → a phantom station at 0,0
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

describe("SR-PARSE-04 — the encoder never emits 60.00 minutes", () => {
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

describe("SR-PARSE-06 — MGRS band letter is correct in 80–84°", () => {
  it("returns X (not Z) for a latitude in the 72–84° X band", () => {
    const m = toMgrs(82, 10); // inside coverage, in the X band
    expect(m).not.toBe("");
    expect(/\s/.test(m)).toBe(true);
    const band = m.match(/^\d+([C-X])/)?.[1];
    expect(band).toBe("X"); // BANDS[20] was undefined → "Z" before
  });

  it("still empty above 84°", () => {
    expect(toMgrs(85, 10)).toBe("");
  });
});
