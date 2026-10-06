// SPDX-License-Identifier: AGPL-3.0-or-later
// A registry's tools are listed in the catalogue's groups: by the group the registry names, else by the
// permissions the tool's manifest asks for.
import { describe, expect, it } from "vitest";
import { groupByKind, kindOfPermissions } from "../src/tools/toolKind.js";

describe("tool groups", () => {
  it("place a tool by its permissions, the gated ones first", () => {
    expect(kindOfPermissions(["command", "beacon"])).toBe("Transmit tools");
    expect(kindOfPermissions(["command", "event", "tx"])).toBe("Transmit tools");
    expect(kindOfPermissions(["decoder", "panel"])).toBe("Decoders");
    expect(kindOfPermissions(["monitor", "event", "panel"])).toBe("Monitor and station tools");
    expect(kindOfPermissions(["event"])).toBe("Responders");
    expect(kindOfPermissions(["command"])).toBe("Utilities");
    expect(kindOfPermissions([])).toBe("Utilities");
  });

  it("list the groups in the catalogue's order, a registry's own after them and the unknown last", () => {
    const items = [
      { n: "a", k: "Utilities" },
      { n: "b", k: "Decoders" },
      { n: "c", k: null },
      { n: "d", k: "Award trackers" },
      { n: "e", k: "Decoders" },
    ];
    const g = groupByKind(items, (i) => i.k);
    expect(g.map((x) => [x.kind, x.items.map((i) => i.n).join("")])).toEqual([
      ["Decoders", "be"],
      ["Utilities", "a"],
      ["Award trackers", "d"],
      ["More tools", "c"],
    ]);
  });
});
