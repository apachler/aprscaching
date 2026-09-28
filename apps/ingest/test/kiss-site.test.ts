// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { kissSiteCall } from "../src/kiss.js";

describe("KISS receiving-site stamp", () => {
  it("names the site on a frame heard directly", () => {
    expect(kissSiteCall([], "oe8apr-10")).toBe("OE8APR-10");
    // an unused WIDE hop is not a relay: the frame still came straight from the originator
    expect(kissSiteCall(["WIDE1-1", "WIDE2-1"], "OE8APR-10")).toBe("OE8APR-10");
  });

  it("names no site on a digipeated frame", () => {
    expect(kissSiteCall(["OE8XBM-10*", "WIDE2-1"], "OE8APR-10")).toBeUndefined();
    expect(kissSiteCall(["WIDE1*", "WIDE2-1"], "OE8APR-10")).toBeUndefined();
  });

  it("names no site when the box has no site call", () => {
    expect(kissSiteCall([], undefined)).toBeUndefined();
    expect(kissSiteCall([], "")).toBeUndefined();
  });
});
