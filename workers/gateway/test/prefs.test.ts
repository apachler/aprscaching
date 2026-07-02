// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { sanitizePrefs } from "../src/prefs.js";

describe("account UI-prefs sanitizer (docs/13)", () => {
  it("keeps only known keys and coerces each to a safe shape", () => {
    const out = sanitizePrefs({
      locale: { locale: "de-AT", timeZone: "Europe/Vienna", units: "metric", theme: "dark", junk: 1 },
      pins: ["terminal", "bbs"],
      basemap: "topo",
      evil: "<script>",              // unknown key → dropped
    });
    expect(out).toEqual({
      locale: { locale: "de-AT", timeZone: "Europe/Vienna", units: "metric", theme: "dark" },
      pins: ["terminal", "bbs"],
      basemap: "topo",
    });
    expect(out).not.toHaveProperty("evil");
  });

  it("rejects bad enum values but keeps valid siblings", () => {
    const out = sanitizePrefs({ locale: { units: "furlongs", theme: "neon", locale: "en-US" } });
    expect(out.locale).toEqual({ locale: "en-US" }); // units/theme dropped, locale kept
  });

  it("caps pins to strings, ≤20 entries, ≤24 chars each; drops non-arrays", () => {
    const out = sanitizePrefs({ pins: ["a".repeat(40), 5, "bbs", ...Array.from({ length: 30 }, (_, i) => `p${i}`)] });
    const pins = out.pins as string[];
    expect(pins.length).toBe(20);
    expect(pins[0]!.length).toBe(24);
    expect(pins).not.toContain(5 as unknown as string);
    expect(sanitizePrefs({ pins: "nope" }).pins).toBeUndefined();
  });

  it("returns an empty object for junk / non-object input", () => {
    expect(sanitizePrefs(null)).toEqual({});
    expect(sanitizePrefs("x")).toEqual({});
    expect(sanitizePrefs(42)).toEqual({});
  });
});
