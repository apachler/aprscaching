// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { fromB64u, toB64u } from "../src/base64url.js";

describe("base64url", () => {
  it("encodes without padding in the URL alphabet (RFC 4648 §5 vectors)", () => {
    const enc = (s: string) => toB64u(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg");
    expect(enc("fo")).toBe("Zm8");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("foob")).toBe("Zm9vYg");
    expect(toB64u(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", () => {
    expect(toB64u(new Uint8Array([1, 2, 3]).buffer)).toBe("AQID");
  });

  it("decodes either alphabet, padded or not", () => {
    expect([...fromB64u("-_-_")]).toEqual([0xfb, 0xff, 0xbf]);
    expect([...fromB64u("+/+/")]).toEqual([0xfb, 0xff, 0xbf]);
    expect(new TextDecoder().decode(fromB64u("Zm9vYg"))).toBe("foob");
    expect(new TextDecoder().decode(fromB64u("Zm9vYg=="))).toBe("foob");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from({ length: 257 }, (_, i) => (i * 37) & 0xff);
    expect([...fromB64u(toB64u(bytes))]).toEqual([...bytes]);
  });
});
