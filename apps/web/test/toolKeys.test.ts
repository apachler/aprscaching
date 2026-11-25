// SPDX-License-Identifier: AGPL-3.0-or-later
// Trust-on-first-use pins follow the manifest's address, never the author a self-signed manifest names about itself.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { keyFingerprint, pinKey, toolTrust } = await import("../src/tools/toolKeys.js");

const REAL = "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc";
const FAKE = "Zx1q9w8e7r6t5y4u3i2o1pAaSsDdFfGgHhJjKkLlZzX";
const realUrl = "https://oe8apr.example/tools/beacon/tool.json";
const fakeUrl = "https://elsewhere.example/tool.json";

beforeEach(() => store.clear());

describe("a self-signed tool's trust", () => {
  it("is not decided by another tool that claims the same author", () => {
    // a stranger's tool names OE8APR as its author, and the user approves it
    expect(toolTrust("valid", fakeUrl, { author: "OE8APR", pubkey: FAKE })).toBe("self-signed");
    pinKey(fakeUrl, FAKE);
    // the real author's tool, installed by its own address, is not refused as a changed key
    expect(toolTrust("valid", realUrl, { author: "OE8APR", pubkey: REAL })).toBe("self-signed");
  });

  it("refuses another key for the manifest at an address the user trusted", () => {
    pinKey(realUrl, REAL);
    expect(toolTrust("valid", realUrl, { author: "OE8APR", pubkey: REAL })).toBe("known");
    expect(toolTrust("valid", realUrl, { author: "OE8APR", pubkey: FAKE })).toBe("key-changed");
  });

  it("takes the registry's listed key before any pin", () => {
    pinKey(realUrl, FAKE);
    expect(toolTrust("valid", realUrl, { author: "OE8APR", pubkey: REAL }, REAL)).toBe("verified");
  });

  it("is named by the key's fingerprint", () => {
    expect(keyFingerprint(REAL)).toBe("uibF UCjc BnxA e8mR");
  });
});
