// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { StationRegistry, classifyStation, baseCall, TYPE_TAG } from "../src/index.js";

describe("NAMES.GP station-type registry", () => {
  it("auto-classifies common APRS hints", () => {
    expect(classifyStation("OE8WX-13", { symbol: "/_" })).toBe("weather");
    expect(classifyStation("OE8DIGI", { symbol: "/#" })).toBe("digi");
    expect(classifyStation("OE8NODE", { payload: "OE8NODE:NODES OE,..." })).toBe("node");
    expect(classifyStation("OE8APR-9", { payload: "!4704.41N/01526.27E>" })).toBe("beacon");
    expect(classifyStation("OE8APR", {})).toBe("user");
  });

  it("tags our own service TOCALL as 'service'", () => {
    expect(classifyStation("OE8APR-7", { dest: "APZACG", ourTocalls: ["APZACG", "APAC"] })).toBe("service");
  });

  it("an explicit override always wins over the classifier", () => {
    const r = new StationRegistry({ OE8BBS: "bbs" });
    expect(r.classify("OE8BBS", { symbol: "/_" })).toBe("bbs"); // would auto-classify weather, override wins
    r.set("OE8BBS", null);
    expect(r.classify("OE8BBS-0", { payload: "!4704.41N/01526.27E>" })).toBe("beacon");
    r.set("oe8bbs", "node"); // case-insensitive
    expect(r.classify("OE8BBS")).toBe("node");
    expect(r.toJSON()).toEqual({ OE8BBS: "node" });
  });

  it("baseCall strips the SSID; every type has a tag", () => {
    expect(baseCall("oe8apr-7")).toBe("OE8APR");
    for (const t of Object.keys(TYPE_TAG)) expect(TYPE_TAG[t as keyof typeof TYPE_TAG]).toBeTruthy();
  });
});
