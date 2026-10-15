// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { HF_APRS, HF_300, decodeMicE, hfBeacon } from "../src/index.js";

describe("the HF APRS preset", () => {
  it("names 30 m at 300 baud: the dial frequency with its sideband, the tones, an empty path", () => {
    expect(HF_APRS).toMatchObject({ dialMhz: 10.1476, mode: "USB", path: [], commentEvery: 4 });
    expect(HF_APRS.modem).toBe(HF_300);
    expect(HF_APRS.beaconMinSec).toBeGreaterThanOrEqual(600);
    expect(HF_APRS.beaconMaxSec).toBeLessThanOrEqual(900);
  });

  it("puts the comment on every fourth beacon, starting with the first", () => {
    const withComment = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
      const { dest, info } = hfBeacon(n, 47.0735, 15.4373, { comment: "QRV 30m", symbol: "/-" });
      const fix = decodeMicE(dest, info)!;
      expect(fix.lat).toBeCloseTo(47.0735, 3);
      expect(fix.code).toBe("-");
      return fix.comment === "QRV 30m";
    });
    expect(withComment).toEqual([true, false, false, false, true, false, false, false, true]);
    expect(hfBeacon(1, 47, 15, { comment: "x" }).info).toHaveLength(9);
  });
});
