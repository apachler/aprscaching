// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { parseRoles, validStationCallsign } from "../src/stations_mine.js";

describe("operated stations — validation", () => {
  it("accepts a base call and a base call with an SSID", () => {
    expect(validStationCallsign("OE8APR")).toBe(true);
    expect(validStationCallsign("oe8apr-1")).toBe(true);   // case-insensitive
    expect(validStationCallsign("OE8APR-13")).toBe(true);
  });

  it("rejects malformed callsigns", () => {
    expect(validStationCallsign("")).toBe(false);
    expect(validStationCallsign("OE8APR-")).toBe(false);
    expect(validStationCallsign("OE 8APR")).toBe(false);
    expect(validStationCallsign("WAY-TOO-LONG")).toBe(false);
  });

  it("parses + whitelists + dedups roles, dropping unknowns", () => {
    expect(parseRoles(["weather", "digipeater", "weather", "bogus"])).toEqual(["weather", "digipeater"]);
    expect(parseRoles("igate, node , relay")).toEqual(["igate", "node", "relay"]);
    expect(parseRoles(undefined)).toEqual([]);
    expect(parseRoles("nonsense")).toEqual([]);
  });
});
