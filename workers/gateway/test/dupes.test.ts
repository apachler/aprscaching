// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { dupeKey, planDupes, type StoredCopy } from "../src/dupes.js";

const pkt = (over: Partial<{ src: string; dst: string; payload: string; ts: number; heardVia: string }> = {}) => ({
  src: "OE1ABC-7",
  dst: "APRS",
  payload: ":OE8APR-15:hi{1",
  ts: 1000,
  heardVia: "aprs_is",
  ...over,
});
const row = (over: Partial<StoredCopy> = {}): StoredCopy => ({
  id: 7,
  callsign: "OE1ABC-7",
  ts: 990,
  dst: "APRS",
  payload: ":OE8APR-15:hi{1",
  heard_via: "aprs_is",
  ...over,
});

describe("duplicate key", () => {
  it("is source with SSID, destination without, and the information field", () => {
    expect(dupeKey(pkt({ dst: "APRS-1" }))).toBe(dupeKey(pkt()));
    expect(dupeKey(pkt({ src: "OE1ABC-9" }))).not.toBe(dupeKey(pkt()));
    expect(dupeKey(pkt({ payload: ":OE8APR-15:hi{2" }))).not.toBe(dupeKey(pkt()));
  });
});

describe("planning the log", () => {
  it("stores the first copy and skips copies within 30 seconds", () => {
    const fates = planDupes([pkt(), pkt({ ts: 1020 }), pkt({ ts: 1031 })], []);
    expect(fates.map((f) => f.kind)).toEqual(["store", "skip", "store"]); // 1031 is 31 s after the stored copy
  });
  it("stores again once the window has passed", () => {
    expect(planDupes([pkt(), pkt({ ts: 1031 })], []).map((f) => f.kind)).toEqual(["store", "store"]);
  });
  it("keeps the RF copy in a batch that also holds an APRS-IS copy", () => {
    const fates = planDupes([pkt(), pkt({ ts: 1002, heardVia: "rf" }), pkt({ ts: 1003, heardVia: "rf" })], []);
    expect(fates.map((f) => f.kind)).toEqual(["skip", "store", "skip"]);
  });
  it("skips a copy already logged, and upgrades a logged APRS-IS copy when RF hears it", () => {
    expect(planDupes([pkt()], [row()])[0]).toEqual({ kind: "skip" });
    expect(planDupes([pkt({ heardVia: "rf" })], [row()])[0]).toMatchObject({ kind: "upgrade", stored: { id: 7 } });
    expect(planDupes([pkt({ heardVia: "rf" })], [row({ heard_via: "rf" })])[0]).toEqual({ kind: "skip" });
  });
  it("upgrades a logged copy once, then skips further RF copies", () => {
    const fates = planDupes([pkt({ heardVia: "rf" }), pkt({ ts: 1001, heardVia: "rf" })], [row()]);
    expect(fates.map((f) => f.kind)).toEqual(["upgrade", "skip"]);
  });
});
