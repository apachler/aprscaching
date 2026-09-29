// SPDX-License-Identifier: MIT
// One name per kind of cache: a one-spot cache is "traditional" and a staged one "multi" — the gateway
// treats no other pair of names differently, so the catalog carries no synonyms.
import { describe, it, expect } from "vitest";
import { CacheType, CreateCacheRequest } from "../src/dto.js";

describe("CacheType", () => {
  it("has no synonyms for traditional or multi", () => {
    expect(CacheType.options).toContain("traditional");
    expect(CacheType.options).toContain("multi");
    expect(CacheType.options).not.toContain("single");
    expect(CacheType.options).not.toContain("two_stage");
  });

  it("a new cache without a type is traditional", () => {
    const r = CreateCacheRequest.parse({ title: "t", lat: 47, lon: 15 });
    expect(r.type).toBe("traditional");
  });
});
