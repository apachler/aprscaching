// SPDX-License-Identifier: AGPL-3.0-or-later
// The result card's sentence on why a find reached its tier: a find an attested site heard, kept below
// Radio-verified because the callsign is not verified yet, says so and how to fix it, rather than blaming APRS-IS.
import { describe, expect, it } from "vitest";
import { UNVERIFIED_CALL_REASON } from "@aprscaching/shared";
import { findWhy } from "../src/log/findWhy.js";
import type { Formatters } from "../src/format.js";
import type { LogResult } from "../src/api.js";

const fmt = { distance: (m: number) => `${m} m` } as Formatters;
const result = (r: Partial<LogResult>): LogResult => ({
  logged: true,
  logType: "found",
  accountVerified: true,
  verified: false,
  ...r,
});

describe("findWhy", () => {
  it("tells an unverified callsign holder to verify it, not that only APRS-IS placed them", () => {
    const why = findWhy(result({ tier: "C", method: "aprs_is", reason: UNVERIFIED_CALL_REASON }), fmt, null, false);
    expect(why).toMatch(/not verified yet/);
    expect(why).toMatch(/Verify your callsign/);
    expect(why).not.toMatch(/APRS-IS/);
  });

  it("names APRS-IS when only an internet position placed the finder", () => {
    const why = findWhy(result({ tier: "C", method: "aprs_is", reason: "IS-only, uncorroborated" }), fmt, null, false);
    expect(why).toMatch(/APRS-IS/);
  });

  it("names the tier a stricter cache asks for", () => {
    const why = findWhy(result({ tier: "B", method: "app_geo", reason: "cache requires tier A" }), fmt, null, true);
    expect(why).toMatch(/needs a Radio-verified find/);
  });
});
