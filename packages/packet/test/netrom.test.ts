// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { NodesTable, reversePath, NodeSession, type NodeStore } from "../src/index.js";

describe("NET/ROM node logic (docs/25 P4)", () => {
  it("NODES table keeps the best-quality route and finds by call or alias", () => {
    const t = new NodesTable();
    t.learn({ dest: "OE8XBM-7", alias: "GRAZ", neighbor: "OE8REL-7", quality: 120 });
    t.learn({ dest: "OE8XBM-7", alias: "GRAZ", neighbor: "OE8DIR-7", quality: 200 }); // better → replaces
    expect(t.best("OE8XBM-7")?.neighbor).toBe("OE8DIR-7");
    expect(t.best("GRAZ")?.quality).toBe(200);
    expect(t.best("NOPE")).toBeNull();
  });

  it("decays route quality and drops dead routes", () => {
    const t = new NodesTable([{ dest: "A", alias: "AA", neighbor: "N", quality: 10 }]);
    t.decay(0.5); expect(t.best("A")?.quality).toBe(5);
    t.decay(0.1); expect(t.best("A")).toBeNull(); // floors to 0 → removed
  });

  it("reverses a heard digi path for the return route (autorouting)", () => {
    expect(reversePath(["OE8REL-7*", "OE3XYZ-7", "OE1ABC-7"])).toEqual(["OE1ABC-7", "OE3XYZ-7", "OE8REL-7"]);
  });

  it("node CLI lists nodes/routes/users/mheard, connects, and disconnects", () => {
    const store: NodeStore = {
      nodes: () => [{ alias: "GRAZ", call: "OE8XBM-7", quality: 200 }],
      routes: () => [{ neighbor: "OE8REL-7", port: "kiss", quality: 180 }],
      users: () => [{ call: "OE8APR", via: "kiss" }],
      mheard: () => [{ call: "OE3ABC", port: "kiss", lastHeard: 0 }],
      info: () => "Graz node",
    };
    const s = new NodeSession("OE8APR", store, "GRAZ", "OE8XBM-7");
    expect(s.greeting()[0]).toMatch(/OE8XBM-7:GRAZ/);
    expect(s.handle("N").lines.some((l) => /GRAZ:OE8XBM-7/.test(l))).toBe(true);
    expect(s.handle("R").lines.some((l) => /OE8REL-7/.test(l))).toBe(true);
    expect(s.handle("U").lines.some((l) => /OE8APR/.test(l))).toBe(true);
    expect(s.handle("MH").lines.some((l) => /OE3ABC/.test(l))).toBe(true);
    expect(s.handle("C OE8XBM-7").connect).toBe("OE8XBM-7");
    expect(s.handle("BYE").disconnect).toBe(true);
    expect(s.handle("ZZ").lines.some((l) => /Invalid command/.test(l))).toBe(true);
  });
});
