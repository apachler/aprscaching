// SPDX-License-Identifier: AGPL-3.0-or-later
// The station exclusion list's pure parts: which call an exclusion names, which packets it drops, and the rows its
// purge reaches.
import { describe, it, expect } from "vitest";
import {
  EXCLUSION_CATEGORIES,
  PURGE_TARGETS,
  exclusionCall,
  excludedPacket,
  isExcludedCall,
  purgeWhere,
} from "../src/exclusions.js";

describe("exclusionCall", () => {
  it("names the base call, whatever SSID the sysop typed", () => {
    expect(exclusionCall("oe1abc")).toBe("OE1ABC");
    expect(exclusionCall(" OE1ABC-9 ")).toBe("OE1ABC");
  });

  it("refuses what is no callsign", () => {
    for (const bad of ["", "AB", "OE1ABCDEFGH", "OE1 ABC", "ABCDEF", "123456", 42, null, undefined])
      expect(exclusionCall(bad), String(bad)).toBeNull();
  });
});

describe("excludedPacket", () => {
  const excluded = new Set(["OE1ABC"]);
  it("drops every SSID of an excluded base call", () => {
    for (const src of ["OE1ABC", "OE1ABC-7", "oe1abc-15"])
      expect(excludedPacket(excluded, { src, payload: "!4700.00N/01500.00E-" })).toBe(true);
  });

  it("drops third-party traffic another station relayed for it", () => {
    expect(excludedPacket(excluded, { src: "OE8XDI", payload: "}OE1ABC-9>APRS,TCPIP,OE8XDI*:>hello" })).toBe(true);
  });

  it("keeps another station's packet that names it only in its path or as addressee", () => {
    expect(excludedPacket(excluded, { src: "OE5XYZ", payload: ":OE1ABC   :hello{1" })).toBe(false);
    expect(excludedPacket(excluded, { src: "OE1ABD", payload: "!4700.00N/01500.00E-" })).toBe(false);
  });

  it("drops nothing while the list is empty", () => {
    expect(excludedPacket(new Set(), { src: "OE1ABC", payload: "x" })).toBe(false);
    expect(isExcludedCall(new Set(), "OE1ABC")).toBe(false);
    expect(isExcludedCall(excluded, "OE1ABC-2")).toBe(true);
  });
});

describe("the purge", () => {
  it("matches the base call and its SSIDs in every column naming the station", () => {
    const links = PURGE_TARGETS.find((t) => t.table === "meshcom_links")!;
    expect(purgeWhere(links, "OE1ABC")).toEqual({
      sql: "(from_call = ? OR from_call LIKE ? OR to_call = ? OR to_call LIKE ?)",
      binds: ["OE1ABC", "OE1ABC-%", "OE1ABC", "OE1ABC-%"],
    });
  });

  it("takes only the station's own messages and the weather heard on the air", () => {
    const messages = PURGE_TARGETS.find((t) => t.table === "messages")!;
    expect(purgeWhere(messages, "OE1ABC").sql).toBe("(from_call = ? OR from_call LIKE ?) AND direction = 'rx'");
    const weather = PURGE_TARGETS.find((t) => t.table === "sensor_readings")!;
    expect(weather.where).toContain("source IS NULL");
  });

  it("never reaches accounts, finds or the aggregate counters", () => {
    const tables = PURGE_TARGETS.map((t) => t.table);
    for (const kept of ["accounts", "account_callsigns", "cache_logs", "caches", "port_stats", "radio_commands"])
      expect(tables).not.toContain(kept);
    expect(EXCLUSION_CATEGORIES).toContain("objection");
  });
});
