// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { hourInBands, partnerDue } from "../src/forward-schedule.js";

const P = (o: Partial<Parameters<typeof partnerDue>[0]> = {}) => ({ enabled: true, intervalMin: 30, timebands: "", ...o });
const HOUR = 3600;
// a fixed UTC instant: 2024-01-01T05:30:00Z → UTC hour 5
const AT_0530Z = Date.UTC(2024, 0, 1, 5, 30, 0) / 1000;

describe("FBB forwarding schedule", () => {
  it("matches simple and multi UTC hour bands, empty = any time", () => {
    expect(hourInBands(5, "")).toBe(true);
    expect(hourInBands(5, "0-6")).toBe(true);
    expect(hourInBands(7, "0-6")).toBe(false);
    expect(hourInBands(23, "0-6,22-23")).toBe(true);
    expect(hourInBands(12, "0-6,22-23")).toBe(false);
    expect(hourInBands(9, "9")).toBe(true);        // single hour
  });

  it("wraps a band past midnight (start > end)", () => {
    expect(hourInBands(23, "22-6")).toBe(true);
    expect(hourInBands(3, "22-6")).toBe(true);
    expect(hourInBands(6, "22-6")).toBe(true);
    expect(hourInBands(7, "22-6")).toBe(false);
    expect(hourInBands(21, "22-6")).toBe(false);
  });

  it("is due when never run, within the band", () => {
    expect(partnerDue(P({ timebands: "0-6" }), null, AT_0530Z)).toBe(true);
  });

  it("is not due before the interval elapses", () => {
    expect(partnerDue(P({ intervalMin: 30 }), AT_0530Z - 10 * 60, AT_0530Z)).toBe(false); // 10 min ago
    expect(partnerDue(P({ intervalMin: 30 }), AT_0530Z - 31 * 60, AT_0530Z)).toBe(true);  // 31 min ago
  });

  it("is not due outside its time-band even when the interval elapsed", () => {
    expect(partnerDue(P({ timebands: "22-23" }), null, AT_0530Z)).toBe(false); // 05:30Z ∉ 22-23
  });

  it("never auto-runs when disabled or manual (interval 0)", () => {
    expect(partnerDue(P({ enabled: false }), null, AT_0530Z)).toBe(false);
    expect(partnerDue(P({ intervalMin: 0 }), null, AT_0530Z)).toBe(false);
  });
});
