// SPDX-License-Identifier: AGPL-3.0-or-later
// Codes and slugs drawn from the CSPRNG are uniform: a raw `random % n` over-weights the low residues
// whenever n does not divide the source range, so draws from the incomplete top block are rejected.
import { describe, it, expect, afterEach, vi } from "vitest";
import { randomInt, randomString } from "../src/util/random.js";

afterEach(() => vi.restoreAllMocks());

/** Make crypto.getRandomValues hand out `values` in order, one per 32-bit word. */
function feed(values: number[]): void {
  const q = [...values];
  vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    const a = arr as unknown as Uint32Array;
    for (let i = 0; i < a.length; i++) a[i] = q.shift() ?? 0;
    return arr;
  });
}

describe("randomInt", () => {
  it("rejects a draw from the incomplete top block and redraws", () => {
    // 2^32 = 4772 * 900000 + 167296: draws of 4_294_800_000 and above would favour the low residues.
    feed([0xffffffff, 4_294_800_000, 123]);
    expect(randomInt(900_000)).toBe(123);
  });

  it("accepts the last draw of the complete range", () => {
    feed([4_294_799_999]);
    expect(randomInt(900_000)).toBe(899_999);
  });

  it("stays in range", () => {
    for (let i = 0; i < 1000; i++) {
      const n = randomInt(36);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(36);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("rejects a non-positive or oversized bound", () => {
    expect(() => randomInt(0)).toThrow();
    expect(() => randomInt(2 ** 32 + 1)).toThrow();
  });
});

describe("randomString", () => {
  it("draws each character uniformly from the alphabet", () => {
    const s = randomString("ab", 4000);
    expect(s).toMatch(/^[ab]{4000}$/);
    const a = [...s].filter((c) => c === "a").length;
    expect(a).toBeGreaterThan(1700);
    expect(a).toBeLessThan(2300);
  });
});
