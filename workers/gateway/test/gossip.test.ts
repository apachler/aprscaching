// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { gossipDue, isFederatedWrite } from "../src/gossip.js";

describe("gossip ping debounce (F5/T2.1)", () => {
  it("acts on the first call, coalesces repeats within the cooldown, re-arms after it", () => {
    const m = new Map<string, number>();
    expect(gossipDue("pull:oe.pub", 1000, m, 2000)).toBe(true); // first → act
    expect(gossipDue("pull:oe.pub", 1500, m, 2000)).toBe(false); // within cooldown → coalesced
    expect(gossipDue("pull:oe.pub", 2999, m, 2000)).toBe(false); // still within cooldown
    expect(gossipDue("pull:oe.pub", 3000, m, 2000)).toBe(true); // cooldown elapsed → act again
  });

  it("keys are independent (push vs pull, and per instance)", () => {
    const m = new Map<string, number>();
    expect(gossipDue("push:me", 1000, m, 2000)).toBe(true);
    expect(gossipDue("pull:me", 1000, m, 2000)).toBe(true); // different direction, same instant
    expect(gossipDue("pull:other", 1000, m, 2000)).toBe(true); // different instance
    expect(gossipDue("push:me", 1100, m, 2000)).toBe(false); // same key still cooling
  });
});

describe("isFederatedWrite — which routes ping peers", () => {
  it("matches the federated-write POST routes only", () => {
    expect(isFederatedWrite("POST", "/api/caches")).toBe(true);
    expect(isFederatedWrite("POST", "/api/caches/42/logs")).toBe(true);
    expect(isFederatedWrite("POST", "/keys/register")).toBe(true);
    expect(isFederatedWrite("POST", "/api/account/OE8APR/delete")).toBe(true);
  });
  it("ignores reads, non-federated writes, and mirror/sync traffic", () => {
    expect(isFederatedWrite("GET", "/api/caches")).toBe(false);
    expect(isFederatedWrite("POST", "/api/caches/42/favorite")).toBe(false);
    expect(isFederatedWrite("POST", "/federation/sync")).toBe(false);
    expect(isFederatedWrite("POST", "/federation/notify")).toBe(false);
    expect(isFederatedWrite("POST", "/api/account/OE8APR/export")).toBe(false);
  });
});
