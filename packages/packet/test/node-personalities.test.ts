// SPDX-License-Identifier: MIT
// Each personality is a different conversation over the SAME routing brain: the store is shared,
// only prompts, command words, and table formats differ. FlexNet's RTT is presentation-only.
import { describe, it, expect } from "vitest";
import { makeNodeSession, qualityToRtt, NODE_PERSONALITIES } from "../src/node-personalities.js";
import type { NodeStore } from "../src/netrom.js";

const store: NodeStore = {
  nodes: () => [
    { alias: "GRAZ", call: "OE6XXX", quality: 200 },
    { alias: "KTN", call: "OE8XBB", quality: 120 },
  ],
  routes: () => [{ neighbor: "OE8XBB-2", port: "vhf", quality: 180 }],
  users: () => [{ call: "DL1ABC" }],
  mheard: () => [{ call: "OE8APR-9", port: "vhf", lastHeard: 1000 }],
  info: () => "APRScaching node under test",
};

const lines = (r: { lines: string[] } | Promise<never>) => (r as { lines: string[] }).lines.join("\n");

describe("node personalities", () => {
  it("qualityToRtt inverts monotonically: better quality → lower displayed RTT", () => {
    expect(qualityToRtt(255)).toBeLessThan(qualityToRtt(120));
    expect(qualityToRtt(120)).toBeLessThan(qualityToRtt(10));
    expect(qualityToRtt(255)).toBeGreaterThanOrEqual(1);
  });

  it("flexnet: D lists destinations with RTT, L shows links, C connects", () => {
    const s = makeNodeSession("flexnet", "dl1abc", store, "ACSNOD", "OE8APR-7");
    expect(s.greeting().join("\n")).toContain("FlexNet");
    const d = lines(s.handle("D"));
    expect(d).toContain("OE6XXX " + qualityToRtt(200));
    expect(d).toContain("OE8XBB " + qualityToRtt(120));
    expect(lines(s.handle("D OE6XXX"))).toContain(`rtt ${qualityToRtt(200)}`);
    expect(lines(s.handle("L"))).toContain("rtt");
    const c = s.handle("C OE8XBB") as { connect?: string };
    expect(c.connect).toBe("OE8XBB");
    expect((s.handle("Q") as { disconnect?: boolean }).disconnect).toBe(true);
  });

  it("tnn: German-flavoured surface over the same store", () => {
    const s = makeNodeSession("tnn", "DL1ABC", store, "ACSNOD", "OE8APR-7");
    expect(s.greeting().join("\n")).toContain("TheNetNode");
    expect(lines(s.handle("N"))).toContain("GRAZ:OE6XXX");
    expect(lines(s.handle("MH"))).toContain("Gehoert");
    expect(lines(s.handle("XYZZY"))).toContain("Unbekanntes Kommando");
    expect((s.handle("QUIT") as { disconnect?: boolean }).disconnect).toBe(true);
  });

  it("baycom: terse minimal box", () => {
    const s = makeNodeSession("baycom", "DL1ABC", store, "ACSNOD", "OE8APR-7");
    expect(s.greeting().join("\n")).toContain("BayCom");
    expect(lines(s.handle("H"))).toBe("C I M U Q\n>");
    expect(lines(s.handle("M"))).toContain("OE8APR-9");
    expect((s.handle("Q") as { disconnect?: boolean }).disconnect).toBe(true);
  });

  it("unknown or absent personality falls back to the native node CLI", () => {
    for (const p of [undefined, "netrom", "bpq-something"]) {
      const s = makeNodeSession(p, "DL1ABC", store, "ACSNOD", "OE8APR-7");
      expect(s.greeting().join("\n")).toContain("APRScaching NET/ROM node");
    }
    expect(NODE_PERSONALITIES).toContain("flexnet");
  });
});
