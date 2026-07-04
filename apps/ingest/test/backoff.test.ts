// SPDX-License-Identifier: AGPL-3.0-or-later
// The reconnect delay must grow while an endpoint stays down and desync across boxes via jitter,
// then reset once the endpoint is reachable again.
import { describe, it, expect } from "vitest";
import { Backoff } from "../src/backoff.js";

describe("exponential backoff with jitter", () => {
  it("grows the base term geometrically, capped, and resets", () => {
    // rand fixed at 0 → factor (0.5 + 0) = 0.5 → delay = 0.5 * min(cap, base*2^n)
    const b = new Backoff({ baseMs: 1000, capMs: 8000, rand: () => 0 });
    expect(b.next()).toBe(500); // 0.5 * 1000
    expect(b.next()).toBe(1000); // 0.5 * 2000
    expect(b.next()).toBe(2000); // 0.5 * 4000
    expect(b.next()).toBe(4000); // 0.5 * 8000 (cap)
    expect(b.next()).toBe(4000); // still capped
    b.reset();
    expect(b.next()).toBe(500); // back to the base term
  });

  it("jitter keeps the delay within [0.5, 1.5) of the exponential term", () => {
    const hi = new Backoff({ baseMs: 1000, capMs: 60_000, rand: () => 0.999 });
    expect(hi.next()).toBeCloseTo(1000 * 1.499, 0); // 0.5 + 0.999 ≈ 1.499
    const lo = new Backoff({ baseMs: 1000, capMs: 60_000, rand: () => 0 });
    expect(lo.next()).toBe(500);
  });
});
