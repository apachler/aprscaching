// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { negotiateFeeds } from "../src/federation_sync.js";

const DEFS = [
  { type: "tombstone", capability: "tombstones" },
  { type: "cache", capability: "caches" },
  { type: "find", capability: "finds" },
  { type: "key", capability: "keys" },
];
const types = (defs: { type: string }[]) => defs.map((d) => d.type);

describe("feed capability negotiation (F5/T2.2)", () => {
  it("a peer speaking our version → pull only the feeds it advertises (order preserved)", () => {
    const wk = { protocolVersions: ["0.1", "0.2"], capabilities: ["caches", "finds"] };
    expect(types(negotiateFeeds(wk, DEFS, "0.2"))).toEqual(["cache", "find"]); // tombstones/keys skipped
  });

  it("a modern peer advertising every capability → pull all, tombstones still first", () => {
    const wk = { protocolVersions: ["0.2"], capabilities: ["tombstones", "caches", "finds", "keys"] };
    expect(types(negotiateFeeds(wk, DEFS, "0.2"))).toEqual(["tombstone", "cache", "find", "key"]);
  });

  it("a legacy peer (no matching protocol version) → try EVERY known feed (404-safe fallback)", () => {
    expect(types(negotiateFeeds({ capabilities: ["caches"] }, DEFS, "0.2"))).toEqual(types(DEFS)); // caps ignored
    expect(types(negotiateFeeds({ protocolVersions: ["0.1"] }, DEFS, "0.2"))).toEqual(types(DEFS));
  });

  it("a modern peer that advertises no capabilities pulls nothing (explicitly empty list)", () => {
    expect(negotiateFeeds({ protocolVersions: ["0.2"], capabilities: [] }, DEFS, "0.2")).toEqual([]);
  });
});
