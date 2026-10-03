// SPDX-License-Identifier: AGPL-3.0-or-later
// The near-cache radio message's text, bearing and speed rule.
import { describe, it, expect } from "vitest";
import { nearText, bearingDeg, compassPoint, isSlow } from "../src/nearradio.js";

describe("nearText", () => {
  it("fits one APRS message: the title is trimmed, then dropped", () => {
    const t = nearText("AC-1234", "Landhaus courtyard", 40.2, 45, 0);
    expect(t).toBe("Near AC-1234 Landhaus courtyard 40m NE. Reply FOUND AC-1234");
    const long = nearText("AC-1234", "A very long title that goes on and on beyond any radio display", 120, 200, 2);
    expect(long.length).toBeLessThanOrEqual(67);
    expect(long).toMatch(/^Near AC-1234 A very .+ 120m S \+2 more\. Reply FOUND AC-1234$/);
    const heritage = nearText("OE/ST-001234567890", "Summit", 150, 300, 9);
    expect(heritage.length).toBeLessThanOrEqual(67);
    expect(heritage).toMatch(/^Near OE\/ST-001234567890 /);
    expect(nearText("AC-1", "Pipe | tilde ~ brace {", 5, 0, 0)).not.toMatch(/[|~{]/);
  });
});

describe("bearing and speed", () => {
  it("gives the compass point from the station to the cache", () => {
    expect(compassPoint(bearingDeg(47, 15, 47.001, 15))).toBe("N");
    expect(compassPoint(bearingDeg(47, 15, 47, 15.001))).toBe("E");
    expect(compassPoint(bearingDeg(47, 15, 46.999, 14.999))).toBe("SW");
    expect(compassPoint(359)).toBe("N");
  });

  it("counts a fix under 10 km/h, or without a speed, as slow", () => {
    expect(isSlow(undefined)).toBe(true);
    expect(isSlow(5)).toBe(true);
    expect(isSlow(5.5)).toBe(false);
  });
});
