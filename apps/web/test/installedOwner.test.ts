// SPDX-License-Identifier: AGPL-3.0-or-later
// installed.ts against a stand-in sandbox: an install whose identity changes while the tool loads writes nothing,
// and a page whose identity another tab replaced never overwrites the new owner's installs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolHost, type ToolManifest } from "@aprscaching/tools";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

vi.stubGlobal("location", new URL("https://aprs.example.net/"));

const host = new ToolHost();
let release: () => void = () => {};
vi.mock("../src/api.js", () => ({ API_BASE: "" }));
vi.mock("../src/prefs.js", () => ({ notePrefChange: () => {}, PREFS_EVENT: "acs:prefs-synced" }));
vi.mock("../src/tools/registries.js", () => ({
  carrierVia: () => ({}),
  fetchToolScript: async () => ({ ok: true, script: "" }),
}));
vi.mock("../src/tools/sandbox.js", () => ({
  fetchToolManifest: async () => ({ ok: false, error: "not in this test" }),
  // the frame takes its time to start: the test decides when it has loaded
  loadSandbox: () => new Promise((res) => (release = () => res({ bind: () => {}, destroy: () => {} }))),
  sandboxTool: (manifest: ToolManifest) => ({ manifest: { ...manifest, entry: "tool.js" }, activate: () => {} }),
}));
vi.mock("../src/tools/host.js", () => ({
  toolHost: host,
  notifyToolsChanged: () => {},
  onToolsChanged: () => () => {},
  setToolEnabled: (n: string, on: boolean) => host.setEnabled(n, on),
}));

const { installTool, readInstalled } = await import("../src/tools/installed.js");
const { claimTools, OWNER_KEY, storageAction, mayWriteInstalls } = await import("../src/tools/toolOwner.js");

const manifest: ToolManifest = {
  name: "beacon-scheduler",
  title: "Beacon scheduler",
  author: "OE8APR",
  version: "1.1.0",
  api: "1.0",
  permissions: ["command", "beacon"],
  surfaces: ["terminal"],
  pubkey: "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc",
};
const install = () =>
  installTool({
    manifest,
    base: "https://aprs.example.net/tools/tools/beacon-scheduler/tool.json",
    carrier: {} as never,
  });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store.clear();
  for (const t of host.list()) host.unregister(t.manifest.name);
});

describe("an install and the identity it was made for", () => {
  it("writes nothing and stops the tool when the identity changed while it loaded", async () => {
    claimTools("OE8APR");
    const pending = install();
    await settle();
    claimTools(""); // signed out while the frame was starting
    release();
    expect(await pending).toBe("the session changed while the tool loaded");
    expect(host.list()).toEqual([]);
    expect(store.get("acs.tools")).toBeUndefined();
  });

  it("is recorded for the identity that made it", async () => {
    claimTools("OE8APR");
    const pending = install();
    await settle();
    release();
    expect(await pending).toBeNull();
    expect(readInstalled().map((r) => r.name)).toEqual(["beacon-scheduler"]);
  });

  it("never overwrites the installs of an identity another tab signed in", async () => {
    claimTools("OE8APR");
    store.set(OWNER_KEY, "DL1ABC"); // another tab: DL1ABC signed in there, with their own installs
    store.set("acs.tools", "[]");
    expect(mayWriteInstalls()).toBe(false);
    const pending = install();
    await settle();
    release();
    expect(await pending).toMatch(/another tab changed who is signed in/);
    expect(store.get("acs.tools")).toBe("[]");
    expect(host.list()).toEqual([]);
  });
});

describe("another tab's change to the stored installs", () => {
  it("stops this page's tools when the browser's installs pass to another identity, and syncs its own", () => {
    claimTools("OE8APR");
    expect(storageAction(OWNER_KEY, "")).toBe("stop"); // signed out in another tab
    expect(storageAction(OWNER_KEY, "DL1ABC")).toBe("stop");
    expect(storageAction(OWNER_KEY, "OE8APR")).toBe("sync");
    expect(storageAction("acs.tools", "[]")).toBe("sync"); // the same player removed a tool there
    store.set(OWNER_KEY, "DL1ABC");
    expect(storageAction("acs.tools", "[]")).toBe("stop");
    expect(storageAction(null, null)).toBe("stop"); // the storage was cleared
    expect(storageAction("acs.pins", "[]")).toBeNull();
  });
});
