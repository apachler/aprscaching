// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import type { MapCache } from "@aprscaching/shared";
import { NO_FILTERS, facetsOf, filtering, passes } from "../src/caches/filters.js";

const cache = (over: Partial<MapCache>): MapCache => ({
  globalId: "x:cache:1",
  id: 1,
  code: "AC-1",
  ownerCall: "OE8APR",
  title: "lake",
  type: "traditional",
  status: "active",
  difficulty: 1,
  terrain: 1,
  lat: 47,
  lon: 15,
  origin: "x",
  mirrored: false,
  originTrust: "native",
  source: "native",
  sourceName: null,
  sourceUrl: null,
  country: null,
  tags: [],
  ...over,
});

describe("cache filters", () => {
  it("pass everything when nothing is set", () => {
    expect(filtering(NO_FILTERS)).toBe(false);
    expect(passes(cache({}), NO_FILTERS)).toBe(true);
  });
  it("match the country without regard to case, and only caches that carry one", () => {
    const f = { ...NO_FILTERS, country: "AT" };
    expect(filtering(f)).toBe(true);
    expect(passes(cache({ country: "at" }), f)).toBe(true);
    expect(passes(cache({ country: "DE" }), f)).toBe(false);
    expect(passes(cache({ country: null }), f)).toBe(false);
  });
  it("match any selected tag", () => {
    const f = { ...NO_FILTERS, tags: ["scenic", "cw"] };
    expect(passes(cache({ tags: ["cw"] }), f)).toBe(true);
    expect(passes(cache({ tags: ["family"] }), f)).toBe(false);
  });
  it("offer the countries once each and the most used tags first", () => {
    const f = facetsOf([
      cache({ country: "AT", tags: ["family", "scenic"] }),
      cache({ country: "at", tags: ["scenic"] }),
      cache({ country: "DE", tags: [] }),
    ]);
    expect(f.countries).toEqual(["AT", "DE"]);
    expect(f.tags).toEqual(["scenic", "family"]);
  });
});
