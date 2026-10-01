// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { inPackArea, locatorBounds, normalizeLocator, packAreaQuery, parsePackArea } from "../src/offlinepack.js";

const round = (b: number[]) => b.map((n) => Math.round(n * 10000) / 10000);

describe("the Maidenhead locator", () => {
  it("spells a locator the usual way, and refuses what is not one", () => {
    expect(normalizeLocator(" jn77SB42 ")).toBe("JN77sb42");
    expect(normalizeLocator("jn")).toBe("JN");
    for (const bad of ["", "J", "JN7", "SN77", "JN77sz", "JN77sb4", "JN77sb42aa"])
      expect(normalizeLocator(bad), bad).toBeNull();
  });

  it("bounds a field, a square, a subsquare and an extended square", () => {
    expect(locatorBounds("JN")).toEqual([0, 40, 20, 50]);
    expect(locatorBounds("JN77")).toEqual([14, 47, 16, 48]);
    expect(round(locatorBounds("JN77sb"))).toEqual([15.5, 47.0417, 15.5833, 47.0833]);
    expect(round(locatorBounds("JN77sb42"))).toEqual([15.5333, 47.05, 15.5417, 47.0542]);
    expect(locatorBounds("AA00")).toEqual([-180, -90, -178, -89]);
  });

  it("round-trips through the query string and names what is wrong", () => {
    expect(parsePackArea(new URLSearchParams(packAreaQuery({ locator: "JN77sb" })))).toEqual({ locator: "JN77sb" });
    expect(parsePackArea(new URLSearchParams("grid=jn77"))).toEqual({ locator: "JN77" });
    expect(parsePackArea(new URLSearchParams("grid=JN7"))).toMatch(/Maidenhead/);
    expect(parsePackArea(new URLSearchParams(""))).toMatch(/Maidenhead/);
  });

  it("tests a point against the square", () => {
    expect(inPackArea({ locator: "JN77sb" }, 47.06, 15.54)).toBe(true);
    expect(inPackArea({ locator: "JN77sb" }, 47.06, 15.6)).toBe(false);
  });
});
