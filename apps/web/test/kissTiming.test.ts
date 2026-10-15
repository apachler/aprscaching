// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  KISS_TIMING_DEFAULTS,
  KISS_TIMING_FIELDS,
  isDefaultKissTiming,
  kissValueText,
  parseKissValue,
  readKissTiming,
} from "../src/rf/kissTiming.js";

describe("KISS timing settings", () => {
  it("defaults to the APRS values: TXDELAY 30, PERSIST 63, SLOTTIME 10", () => {
    expect(KISS_TIMING_DEFAULTS).toEqual({ txDelay: 30, persist: 63, slotTime: 10 });
    expect(isDefaultKissTiming(KISS_TIMING_DEFAULTS)).toBe(true);
    expect(isDefaultKissTiming({ ...KISS_TIMING_DEFAULTS, persist: 255 })).toBe(false);
  });

  it("gives every setting a label and a one-line hint", () => {
    expect(KISS_TIMING_FIELDS.map((f) => f.key)).toEqual(["txDelay", "persist", "slotTime"]);
    for (const f of KISS_TIMING_FIELDS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.hint).not.toMatch(/\n/);
    }
  });

  it("takes a whole number from 0 to 255 and nothing else", () => {
    expect(parseKissValue("0")).toBe(0);
    expect(parseKissValue(" 255 ")).toBe(255);
    expect(parseKissValue("30")).toBe(30);
    for (const bad of ["", "256", "-1", "1.5", "1e2", "abc", "0x10", "1000"]) expect(parseKissValue(bad)).toBeNull();
  });

  it("reads a value as the person thinks of it", () => {
    expect(kissValueText("txDelay", 30)).toBe("300 ms");
    expect(kissValueText("slotTime", 10)).toBe("100 ms");
    expect(kissValueText("persist", 63)).toBe("1 in 4");
    expect(kissValueText("persist", 0)).toBe("1 in 256");
    expect(kissValueText("persist", 99)).toBe("39%");
    expect(kissValueText("persist", 255)).toBe("every free slot");
  });

  it("reads the stored settings, keeping each valid value and defaulting the rest", () => {
    expect(readKissTiming(null)).toEqual(KISS_TIMING_DEFAULTS);
    expect(readKissTiming("not json")).toEqual(KISS_TIMING_DEFAULTS);
    expect(readKissTiming('{"txDelay":50,"persist":300,"slotTime":"10"}')).toEqual({
      txDelay: 50,
      persist: 63,
      slotTime: 10,
    });
    expect(readKissTiming('{"txDelay":0,"persist":255,"slotTime":20}')).toEqual({
      txDelay: 0,
      persist: 255,
      slotTime: 20,
    });
  });
});
