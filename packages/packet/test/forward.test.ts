// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseHierAddr, ForwardRouter, buildProposal, parseFS } from "../src/index.js";

describe("FBB hierarchical addressing + forward routing", () => {
  it("parses a full H-address into bbs + hierarchy", () => {
    expect(parseHierAddr("OE8APR @ OE8XBM.#OE3.OE.EU")).toEqual({
      to: "OE8APR",
      bbs: "OE8XBM",
      hier: ["#OE3", "OE", "EU"],
    });
    expect(parseHierAddr("ALL")).toEqual({ to: "ALL", bbs: null, hier: [] });
    expect(parseHierAddr("BLN @ WW")).toEqual({ to: "BLN", bbs: "WW", hier: [] });
  });

  it("routes to the MOST specific matching partner", () => {
    const r = new ForwardRouter([
      { partner: "ip-fed", route: "*" }, // catch-all (the federated/IP partner)
      { partner: "rf-eu", route: "EU" },
      { partner: "rf-oe", route: "OE" },
    ]);
    // OE is more specific (earlier in the chain) than EU → rf-oe
    expect(r.route(parseHierAddr("OE8APR @ OE8XBM.#OE3.OE.EU"))?.partner).toBe("rf-oe");
    // a DL address matches only EU → rf-eu (beats the catch-all)
    expect(r.route(parseHierAddr("DL1ABC @ DB0XYZ.#BAY.DL.EU"))?.partner).toBe("rf-eu");
    // nothing European → falls through to the catch-all
    expect(r.route(parseHierAddr("W1AW @ W1XYZ.MA.USA.NOAM"))?.partner).toBe("ip-fed");
  });

  it("matches a partner by its exact BBS too, and returns null when nothing matches", () => {
    const r = new ForwardRouter([{ partner: "direct", route: "OE8XBM" }]);
    expect(r.route(parseHierAddr("OE8APR @ OE8XBM.OE.EU"))?.partner).toBe("direct");
    expect(r.route(parseHierAddr("OE8APR @ DB0XYZ.DL.EU"))).toBeNull();
  });

  it("builds an FB proposal block ending in F> and parses the FS reply", () => {
    const lines = buildProposal([
      { type: "B", from: "OE8APR", to: "ALL", atBbs: "WW", bid: "12_oe", size: 240 },
      { type: "P", from: "OE8APR", to: "DL1ABC", atBbs: "DB0XYZ", bid: "13_oe", size: 80 },
    ]);
    expect(lines[0]).toBe("FB B OE8APR WW ALL 12_oe 240");
    expect(lines.at(-1)).toBe("F>");
    expect(parseFS("FS +-")).toEqual(["accept", "reject"]);
    expect(parseFS("FS Y=N")).toEqual(["accept", "defer", "reject"]);
  });
});
