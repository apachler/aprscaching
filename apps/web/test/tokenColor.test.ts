// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { cssColorToHex } from "../src/shell/tokenColor.js";

/** Channel distance: a converted colour may differ from the reference by rounding. */
const near = (a: string | null, b: string) =>
  !!a && [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 2);

describe("cssColorToHex reads every form a browser reports a resolved colour in", () => {
  it("rgb() and rgba(), comma or space separated", () => {
    expect(cssColorToHex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(cssColorToHex("rgba(18, 52, 86, 0.5)")).toBe("#123456");
    expect(cssColorToHex("rgb(18 52 86 / 50%)")).toBe("#123456");
  });
  it("color(srgb …), as Chromium reports color-mix()", () => {
    expect(cssColorToHex("color(srgb 1 0.5 0)")).toBe("#ff8000");
    expect(cssColorToHex("color(srgb 0.2 0.4 0.6 / 0.3)")).toBe("#336699");
  });
  it("oklab() and oklch(), as Firefox and Safari report them", () => {
    expect(cssColorToHex("oklab(1 0 0)")).toBe("#ffffff");
    expect(cssColorToHex("oklab(0 0 0)")).toBe("#000000");
    expect(near(cssColorToHex("oklch(0.62796 0.25768 29.23)"), "#ff0000")).toBe(true);
    expect(near(cssColorToHex("oklch(62.796% 0.25768 29.23)"), "#ff0000")).toBe(true);
    expect(near(cssColorToHex("oklab(0.86644 -0.23389 0.1795)"), "#00ff00")).toBe(true);
    expect(near(cssColorToHex("oklab(0.45201 -0.03246 -0.31153)"), "#0000ff")).toBe(true);
  });
  it("a form it does not read is null, so the caller can fall back", () => {
    expect(cssColorToHex("color(display-p3 1 0 0)")).toBeNull();
    expect(cssColorToHex("lab(50 20 30)")).toBeNull();
    expect(cssColorToHex("transparent")).toBeNull();
  });
});
