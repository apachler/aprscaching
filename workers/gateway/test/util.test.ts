import { describe, it, expect } from "vitest";
import { b64urlToBytes, b64urlToStr, bytesToB64, bytesToB64url, strToB64url } from "../src/util/b64.js";
import { nowS } from "../src/util/time.js";

describe("util/b64", () => {
  const bytes = Uint8Array.from({ length: 70 }, (_, i) => (i * 37 + 250) & 0xff);

  it("round-trips bytes through base64url for every length remainder", () => {
    for (let n = 0; n < 8; n++) {
      const b = bytes.subarray(0, n);
      const s = bytesToB64url(b);
      expect(s).not.toMatch(/[+/=]/);
      expect([...b64urlToBytes(s)]).toEqual([...b]);
    }
  });

  it("matches Node's base64url and base64 encoders", () => {
    expect(bytesToB64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    expect(bytesToB64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("decodes the standard alphabet, padded or not", () => {
    const std = Buffer.from(bytes).toString("base64");
    expect([...b64urlToBytes(std)]).toEqual([...bytes]);
    expect([...b64urlToBytes(std.replace(/=+$/, ""))]).toEqual([...bytes]);
  });

  it("encodes large buffers without overflowing the argument list", () => {
    const big = new Uint8Array(200_000).fill(7);
    expect(b64urlToBytes(bytesToB64url(big)).length).toBe(big.length);
  });

  it("throws on malformed input", () => {
    expect(() => b64urlToBytes("a")).toThrow();
    expect(() => b64urlToBytes("@@@@")).toThrow();
  });

  it("round-trips binary strings", () => {
    expect(b64urlToStr(strToB64url("1700000000:42"))).toBe("1700000000:42");
    expect(strToB64url("\xff\xfe")).toBe("__4");
  });
});

describe("util/time", () => {
  it("is whole unix seconds", () => {
    const t = nowS();
    expect(Number.isInteger(t)).toBe(true);
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(2);
  });
});
