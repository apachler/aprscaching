// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolManifest } from "@aprscaching/tools";
import {
  MAX_INSTALLED,
  beyondApproval,
  fitsBudget,
  normalizeInstalled,
  recordFor,
  withRecord,
  type InstalledRecord,
} from "../src/tools/installedRecords.js";
import { claimTools, onToolOwnerChange, OWNER_KEY, toolOwner, toolsOwnedBy } from "../src/tools/toolOwner.js";

const KEY = "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc";
const rec = (name: string, extra: Partial<InstalledRecord> = {}): InstalledRecord => ({
  name,
  title: name,
  url: `https://aprs.example.net/tools/tools/${name}/tool.json`,
  pubkey: KEY,
  grants: ["command"],
  connect: [],
  remote: false,
  on: true,
  ...extra,
});
const manifest = (extra: Partial<ToolManifest> = {}): ToolManifest => ({
  name: "net-tool",
  title: "Net tool",
  author: "OE8APR",
  version: "1.0.0",
  permissions: ["command", "network"],
  surfaces: ["web"],
  connect: ["https://api.example.org"],
  pubkey: KEY,
  ...extra,
});

describe("installed tool records", () => {
  it("are empty for a fresh player", () => {
    expect(normalizeInstalled(undefined)).toEqual([]);
    expect(normalizeInstalled("[]")).toEqual([]);
  });

  it("keep well-formed records, once per name, with known grants and origins only", () => {
    const out = normalizeInstalled([
      {
        ...rec("mheard"),
        grants: ["monitor", "panel", "root"],
        connect: ["https://a.example/", "http://plain.example", "nope"],
        remote: "yes",
        via: { id: "builtin", account: "yes" },
      },
      rec("mheard", { on: false }),
      rec("Bad Name"),
      { ...rec("js"), url: "javascript:alert(1)" },
      { ...rec("nokey"), pubkey: "short" },
      42,
    ]);
    expect(out).toEqual([
      {
        ...rec("mheard"),
        grants: ["monitor", "panel"],
        connect: ["https://a.example"],
        remote: false,
        via: { id: "builtin", account: false },
      },
    ]);
  });

  it("hold at most MAX_INSTALLED tools, and fit the account's settings", () => {
    const many = Array.from({ length: MAX_INSTALLED + 5 }, (_, i) => rec(`tool-${i}`));
    expect(normalizeInstalled(many)).toHaveLength(MAX_INSTALLED);
    expect(fitsBudget(many.slice(0, MAX_INSTALLED))).toBe(true);
    const wide = many.map((r) => ({
      ...r,
      connect: Array.from({ length: 8 }, (_, i) => `https://h${i}.${"x".repeat(60)}.org`),
    }));
    expect(fitsBudget(wide)).toBe(false);
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

describe("what a manifest asks for beyond the approval", () => {
  const approved = recordFor(manifest(), "https://x.example/tool.json");
  it("records the permissions, origins and remote use approved", () => {
    expect(approved).toMatchObject({
      grants: ["command", "network"],
      connect: ["https://api.example.org"],
      remote: false,
      title: "Net tool",
    });
  });
  it("is nothing while the manifest stays within it", () => {
    expect(beyondApproval(manifest(), approved)).toEqual([]);
    expect(beyondApproval(manifest({ permissions: ["command"], connect: [] }), approved)).toEqual([]);
  });
  it("names a new permission, a new origin and remote use", () => {
    expect(
      beyondApproval(
        manifest({
          permissions: ["command", "network", "tx"],
          connect: ["https://api.example.org", "https://elsewhere.example"],
          remote: true,
        }),
        approved,
      ),
    ).toEqual(["tx", "network access to https://elsewhere.example", "commands for remote peers"]);
  });
});

describe("whose installed tools this browser holds", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("clears another identity's installs and stops its tools, and keeps the same identity's", () => {
    const stopped = vi.fn();
    onToolOwnerChange(stopped);
    store.set(OWNER_KEY, "OE8APR");
    store.set("acs.tools", JSON.stringify([rec("beacon-scheduler")]));
    expect(claimTools("oe8apr")).toBe(false); // the same player, reloaded
    expect(store.get("acs.tools")).toBeDefined();
    expect(toolOwner()).toBe("OE8APR");
    expect(toolsOwnedBy("OE8APR")).toBe(true);
    expect(claimTools("")).toBe(true); // signed out on a shared computer
    expect(stopped).toHaveBeenCalledOnce();
    expect(store.get("acs.tools")).toBeUndefined();
    expect(toolsOwnedBy("OE8APR")).toBe(false);
    store.set("acs.tools", JSON.stringify([rec("mheard")])); // a guest installs something
    expect(claimTools("DL1ABC")).toBe(true); // the next player signs in: the guest's installs do not follow them
    expect(store.get("acs.tools")).toBeUndefined();
    expect(stopped).toHaveBeenCalledTimes(2);
  });
});
