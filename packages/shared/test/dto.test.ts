// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { CacheTitle, CreateCacheRequest, UpdateCacheRequest } from "../src/index.js";

describe("cache title", () => {
  it("accepts one line of text, trimmed", () => {
    expect(CacheTitle.parse("  Old mill — Mühle ")).toBe("Old mill — Mühle");
  });

  it("refuses control characters", () => {
    for (const t of ["Old\nmill", "Old\rmill", "Old\0mill", "Old\x7fmill", "Old\tmill"])
      expect(CacheTitle.safeParse(t).success, JSON.stringify(t)).toBe(false);
    expect(CreateCacheRequest.safeParse({ title: "a\r\nb", lat: 47, lon: 15 }).success).toBe(false);
    expect(UpdateCacheRequest.safeParse({ title: "a\nb" }).success).toBe(false);
  });
});
