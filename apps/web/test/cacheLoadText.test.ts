// SPDX-License-Identifier: AGPL-3.0-or-later
// A cache that did not load says why: the server's reason when the cache is gone, the connection otherwise.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { ApiError, NetworkError, cacheLoadText } from "../src/api.js";

const FALLBACK = "Couldn't load that cache — check your connection and tap it again.";

describe("the reason a cache did not load", () => {
  it("is the server's own message for a removed or missing cache", () => {
    const removed = new ApiError("this cache was removed by the instance operator", 410, null);
    expect(cacheLoadText(removed, FALLBACK)).toBe("this cache was removed by the instance operator");
    expect(cacheLoadText(new ApiError("no such cache", 404, null), FALLBACK)).toBe("no such cache");
  });

  it("points at the connection for anything else", () => {
    expect(cacheLoadText(new NetworkError(), FALLBACK)).toBe(FALLBACK);
    expect(cacheLoadText(new ApiError("boom", 500, null), FALLBACK)).toBe(FALLBACK);
  });
});
