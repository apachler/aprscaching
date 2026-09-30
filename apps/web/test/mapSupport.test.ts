// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { canDrawMap, fallbackBbox } from "../src/platform/mapSupport.js";

/** A canvas whose getContext answers as a browser with the given contexts would. */
const canvas =
  (contexts: string[], throws = false) =>
  () => ({
    getContext: (kind: string) => {
      if (throws) throw new Error("blocked");
      return contexts.includes(kind) ? {} : null;
    },
  });

describe("canDrawMap", () => {
  it("needs a WebGL2 context, the one MapLibre draws with", () => {
    expect(canDrawMap(canvas(["webgl2", "webgl"]))).toBe(true);
    expect(canDrawMap(canvas(["webgl"]))).toBe(false);
    expect(canDrawMap(canvas([]))).toBe(false);
  });

  it("treats a getContext that throws as no WebGL", () => {
    expect(canDrawMap(canvas(["webgl2"], true))).toBe(false);
  });
});

describe("fallbackBbox", () => {
  it("frames the position in the map hash", () => {
    const [w, s, e, n] = fallbackBbox("#12/47.07/15.43", [15.42, 47.07]);
    expect((w + e) / 2).toBeCloseTo(15.43, 5);
    expect((s + n) / 2).toBeCloseTo(47.07, 5);
    expect(e - w).toBeGreaterThan(0.5);
    expect(n - s).toBeGreaterThan(0.3);
  });

  it("falls back to the default centre without a usable hash", () => {
    for (const hash of ["", "#", "#12/abc/15", "#12/95/15"]) {
      const [w, s, e, n] = fallbackBbox(hash, [15.42, 47.07]);
      expect((w + e) / 2).toBeCloseTo(15.42, 5);
      expect((s + n) / 2).toBeCloseTo(47.07, 5);
    }
  });
});
