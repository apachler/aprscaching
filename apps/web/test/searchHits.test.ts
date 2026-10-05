// SPDX-License-Identifier: AGPL-3.0-or-later
// The search suggestions list each cache and station once.
import { describe, expect, it } from "vitest";
import { uniqueHits } from "../src/search/hits.js";
import type { SearchHitCache, SearchHitStation } from "@aprscaching/shared";

const cache = (id: number, code: string): SearchHitCache => ({
  kind: "cache",
  id,
  code,
  title: "Schlossberg",
  ownerCall: "OE8APR",
  type: "traditional",
  lat: 47,
  lon: 15,
});
const station = (callsign: string): SearchHitStation => ({
  kind: "station",
  callsign,
  symbol: null,
  comment: null,
  lat: 47,
  lon: 15,
});

describe("search suggestions", () => {
  it("keep the first of each cache and station, in order", () => {
    const hits = uniqueHits([
      cache(1, "AC-1"),
      cache(2, "AC-2"),
      cache(1, "AC-1"),
      station("oe8apr"),
      station("OE8APR"),
    ]);
    expect(hits.map((h) => (h.kind === "cache" ? h.code : h.callsign))).toEqual(["AC-1", "AC-2", "oe8apr"]);
  });
});
