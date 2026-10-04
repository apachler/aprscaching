// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { SITE_CALL_RE } from "../src/index.js";

describe("SITE_CALL_RE", () => {
  it("takes a base call with an optional numeric SSID", () => {
    for (const c of ["OE8ABC", "OE8ABC-1", "OE8ABC-10", "W1AW", "DB0XYZ-15"]) expect(SITE_CALL_RE.test(c)).toBe(true);
  });
  it("refuses letter SSIDs, long SSIDs and lower case, as the gateway does", () => {
    for (const c of ["OE8ABC-A", "OE8ABC-1A", "OE8ABC-100", "oe8abc", "OE", "OE8ABC-"])
      expect(SITE_CALL_RE.test(c)).toBe(false);
  });
});
