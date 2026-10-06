// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { MAX_INSTALLED, normalizeInstalled, withRecord, type InstalledRecord } from "../src/tools/installedRecords.js";

const KEY = "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc";
const rec = (name: string, extra: Partial<InstalledRecord> = {}): InstalledRecord => ({
  name,
  url: `https://aprs.example.net/tools/tools/${name}/tool.json`,
  pubkey: KEY,
  grants: ["command"],
  on: true,
  ...extra,
});

describe("installed tool records", () => {
  it("are empty for a fresh player", () => {
    expect(normalizeInstalled(undefined)).toEqual([]);
    expect(normalizeInstalled("[]")).toEqual([]);
  });

  it("keep well-formed records, once per name, with known grants only", () => {
    const out = normalizeInstalled([
      { ...rec("mheard"), grants: ["monitor", "panel", "root"], via: { id: "builtin", account: "yes" } },
      rec("mheard", { on: false }),
      rec("Bad Name"),
      { ...rec("js"), url: "javascript:alert(1)" },
      { ...rec("nokey"), pubkey: "short" },
      42,
    ]);
    expect(out).toEqual([{ ...rec("mheard"), grants: ["monitor", "panel"], via: { id: "builtin", account: false } }]);
  });

  it("hold at most MAX_INSTALLED tools", () => {
    const many = Array.from({ length: MAX_INSTALLED + 5 }, (_, i) => rec(`tool-${i}`));
    expect(normalizeInstalled(many)).toHaveLength(MAX_INSTALLED);
  });

  it("replace a record of the same name, else add it at the end", () => {
    const list = [rec("a1"), rec("b2")];
    expect(withRecord(list, rec("a1", { on: false })).map((r) => [r.name, r.on])).toEqual([
      ["a1", false],
      ["b2", true],
    ]);
    expect(withRecord(list, rec("c3")).map((r) => r.name)).toEqual(["a1", "b2", "c3"]);
  });
});
