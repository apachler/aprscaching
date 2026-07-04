// SPDX-License-Identifier: MIT
// The codec's job is byte-determinism: one value ⇒ exactly one encoding, one encoding ⇒ exactly one
// value. Golden vectors come from RFC 8949 Appendix A; the rejection cases are the hostile inputs a
// federation peer could feed the decoder (non-canonical forms, floats, tags, bombs).
import { describe, it, expect } from "vitest";
import { cborEncode, cborDecode, toCborValue, fromCborValue, type CborMap, type CborValue } from "../src/cbor.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const m = (entries: [number | string, CborValue][]): CborMap => new Map(entries);

describe("cborEncode — RFC 8949 Appendix A golden vectors", () => {
  const vectors: [CborValue, string][] = [
    [0, "00"],
    [1, "01"],
    [10, "0a"],
    [23, "17"],
    [24, "1818"],
    [25, "1819"],
    [100, "1864"],
    [1000, "1903e8"],
    [1000000, "1a000f4240"],
    [1000000000000, "1b000000e8d4a51000"],
    [-1, "20"],
    [-10, "29"],
    [-100, "3863"],
    [-1000, "3903e7"],
    [false, "f4"],
    [true, "f5"],
    [null, "f6"],
    ["", "60"],
    ["a", "6161"],
    ["IETF", "6449455446"],
    ["ü", "62c3bc"],
    [new Uint8Array([1, 2, 3, 4]), "4401020304"],
    [[], "80"],
    [[1, 2, 3], "83010203"],
    [[1, [2, 3], [4, 5]], "8301820203820405"],
    [m([]), "a0"],
    [
      m([
        [1, 2],
        [3, 4],
      ]),
      "a201020304",
    ],
    [m([["a", 1], ["b", [2, 3]]]), "a26161016162820203"],
  ];
  for (const [value, expected] of vectors) {
    it(`encodes ${JSON.stringify(value instanceof Map ? [...value] : value)} -> ${expected}`, () => {
      expect(hex(cborEncode(value))).toBe(expected);
    });
  }

  it("encodes a 25-element array with a 1-byte length argument", () => {
    const arr = Array.from({ length: 25 }, (_, i) => i + 1);
    expect(hex(cborEncode(arr)).startsWith("9819")).toBe(true);
  });

  it("sorts map keys by their ENCODED bytes regardless of insertion order", () => {
    const a = m([
      ["z", 1],
      [10, 2],
      ["a", 3],
    ]);
    const b = m([
      ["a", 3],
      ["z", 1],
      [10, 2],
    ]);
    // int key 10 (0x0a) < text "a" (0x61…) < text "z" (0x7a…)
    expect(hex(cborEncode(a))).toBe(hex(cborEncode(b)));
    expect(hex(cborEncode(a))).toBe("a30a02616103617a01");
  });

  it("rejects floats and non-safe integers", () => {
    expect(() => cborEncode(1.5)).toThrow(/safe integers/);
    expect(() => cborEncode(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integers/);
  });
});

describe("cborDecode — canonical round-trip + hostile-input rejection", () => {
  it("round-trips every encodable shape", () => {
    const v: CborValue = m([
      [1, "cache"],
      [2, [1, 2, new Uint8Array([9, 8])]],
      [
        7,
        m([
          ["latE7", 470830000],
          ["lonE7", -154230000],
          ["ok", true],
          ["none", null],
        ]),
      ],
    ]);
    const bytes = cborEncode(v);
    expect(cborDecode(bytes)).toEqual(v);
  });

  const reject = (hexBytes: string, why: RegExp) => {
    expect(() => cborDecode(fromHex(hexBytes))).toThrow(why);
  };

  it("rejects non-shortest-form integers (0 encoded in a 1-byte argument)", () => {
    reject("1800", /not canonical/);
  });
  it("rejects unsorted map keys", () => {
    reject("a202010102", /not canonical/); // keys 2 then 1
  });
  it("rejects duplicate map keys", () => {
    reject("a2010201f4", /not canonical/); // {1:2, 1:false} — Map collapses it, re-encode differs
    reject("a20102010a", /not canonical/); // {1:2, 1:10} — same key twice, later value
  });
  it("rejects floats, tags, and indefinite lengths", () => {
    reject("f93c00", /deterministic subset/); // half-float 1.0
    reject("c074323031332d30332d32315432303a30343a30305a", /deterministic subset/); // tag 0
    reject("9f01ff", /./); // indefinite array
  });
  it("rejects trailing bytes and truncation", () => {
    reject("0001", /trailing/);
    reject("62c3", /truncated|invalid/i);
    reject("8301", /truncated|exceeds input/);
  });
  it("rejects allocation bombs (huge claimed lengths)", () => {
    reject("9a7fffffff00", /exceeds input/);
    reject("ba7fffffff", /exceeds input/);
  });
  it("rejects nesting bombs", () => {
    const deep = "81".repeat(64) + "00";
    reject(deep, /nesting/);
  });
});

describe("toCborValue / fromCborValue — the JSON-like bridge", () => {
  it("converts objects to text-keyed maps and back, dropping undefined fields", () => {
    const obj = { b: 1, a: [true, null, "x"], skip: undefined, nested: { n: -5 } };
    const v = toCborValue(obj);
    expect(fromCborValue(v)).toEqual({ b: 1, a: [true, null, "x"], nested: { n: -5 } });
    // deterministic bytes regardless of object key insertion order
    const obj2 = { nested: { n: -5 }, a: [true, null, "x"], b: 1 };
    expect(hex(cborEncode(toCborValue(obj2)))).toBe(hex(cborEncode(v)));
  });
  it("refuses fractional numbers — coordinates must be pre-scaled to integers", () => {
    expect(() => toCborValue({ lat: 47.083 })).toThrow(/scale to an integer/);
  });
});
