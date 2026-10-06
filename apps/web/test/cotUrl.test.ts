// SPDX-License-Identifier: AGPL-3.0-or-later
// The TAK/CoT feed address is absolute: a TAK client pasting it knows nothing of the page it came from.
// A refused offline log reads as what happened and what to do.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { cotUrl, refusalAdvice } from "../src/api.js";

describe("the TAK/CoT feed address", () => {
  it("is absolute on the page's origin, with the box rounded", () => {
    expect(cotUrl([15.123456789, 47.0, 15.5, 47.25], "https://aprscaching.net")).toBe(
      "https://aprscaching.net/api/cot?bbox=15.1235,47,15.5,47.25",
    );
  });
});

describe("a refused offline log", () => {
  it("explains an unregistered device key and says what to do", () => {
    const advice = refusalAdvice("author key not registered to callsign");
    expect(advice).toMatch(/not registered/);
    expect(advice).toMatch(/Retry/);
  });
  it("keeps the instance's own words for any other reason", () => {
    expect(refusalAdvice("no such cache")).toBe("no such cache");
  });
});
