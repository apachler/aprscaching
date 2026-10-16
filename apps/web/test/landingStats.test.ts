// SPDX-License-Identifier: AGPL-3.0-or-later
// The landing page's live counts: the instance's own numbers, each shown only above its floor.
import { describe, expect, it } from "vitest";
import { statsShown } from "../src/landingStats.js";

describe("landing counts", () => {
  it("show every count above its floor, in a fixed order", () => {
    expect(statsShown({ stationsHeardLastHour: 1284, caches: 40, findsOnAirThisWeek: 12 })).toEqual([
      ["caches", 40],
      ["findsOnAirThisWeek", 12],
      ["stationsHeardLastHour", 1284],
    ]);
  });

  it("leave out a count below its floor", () => {
    expect(statsShown({ caches: 3, findsOnAirThisWeek: 0, stationsHeardLastHour: 300 })).toEqual([
      ["stationsHeardLastHour", 300],
    ]);
  });

  it("show nothing on a new instance", () => {
    expect(statsShown({ caches: 3, findsOnAirThisWeek: 0, stationsHeardLastHour: 2 })).toEqual([]);
  });
});
