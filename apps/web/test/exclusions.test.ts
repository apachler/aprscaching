// SPDX-License-Identifier: AGPL-3.0-or-later
// Excluded stations in Instance admin: the call the form sends, the words the confirm dialog lists for the purge,
// and how the audit log reads an exclusion.
import { describe, it, expect } from "vitest";
import {
  EXCLUSION_CATEGORIES,
  actionName,
  exclusionCall,
  exclusionCategoryLabel,
  purgeLines,
} from "../src/moderation/logic.js";

describe("the excluded call", () => {
  it("is the base call in upper case, whatever SSID was typed", () => {
    expect(exclusionCall("oe1abc")).toBe("OE1ABC");
    expect(exclusionCall(" OE1ABC-9 ")).toBe("OE1ABC");
  });
  it("is null for what is no callsign", () => {
    for (const bad of ["", "AB", "OE1 ABC", "ABCDEF", "123456", "OE1ABCDEFGH"])
      expect(exclusionCall(bad), bad).toBeNull();
  });
});

describe("what the confirm dialog lists", () => {
  it("names each kind with rows, singular or plural, in a fixed order", () => {
    expect(purgeLines({ positions: 3, stations: 1, packets: 0, watchAlerts: 2 })).toEqual([
      "1 map entry",
      "3 positions",
      "2 watch alerts",
    ]);
  });
  it("is empty when the instance holds nothing of the station", () => {
    expect(purgeLines({})).toEqual([]);
    expect(purgeLines({ positions: 0 })).toEqual([]);
  });
});

describe("categories and the audit log", () => {
  it("labels each category, and passes an unknown one through", () => {
    expect(EXCLUSION_CATEGORIES.map((c) => c.value)).toEqual(["objection", "erasure", "other"]);
    expect(exclusionCategoryLabel("objection")).toMatch(/Art\. 21/);
    expect(exclusionCategoryLabel("later")).toBe("later");
  });
  it("reads an exclusion and its lift as verbs", () => {
    expect(actionName("exclude")).toBe("excluded");
    expect(actionName("include")).toBe("lifted the exclusion of");
  });
});
