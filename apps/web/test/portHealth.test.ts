// SPDX-License-Identifier: AGPL-3.0-or-later
// A transport port's status line: the rate while a report is current, the parse share and invalid frames once
// the ingest box reported any, and the RX count always.
import { describe, expect, it } from "vitest";
import type { PortStat } from "@aprscaching/shared";
import { portHealthParts } from "../src/identity/portHealth.js";

const num = (n: number, max = 1) => new Intl.NumberFormat("en-US", { maximumFractionDigits: max }).format(n);
const port = (over: Partial<PortStat>): PortStat => ({
  port: "kiss-tnc",
  rx: 1234,
  tx: 0,
  lastBucket: 0,
  heard: 0,
  parsed: 0,
  invalid: 0,
  pps: null,
  ...over,
});

describe("portHealthParts", () => {
  it("shows the rate, the parse share, the invalid frames and the RX count", () => {
    expect(portHealthParts(port({ pps: 0.42, heard: 200, parsed: 197, invalid: 3 }), num)).toEqual([
      "0.42 pkt/s",
      "98% parsed",
      "3 invalid",
      "1,234 rx",
    ]);
  });

  it("never rounds a parse share up to 100% while a frame failed", () => {
    expect(portHealthParts(port({ heard: 1000, parsed: 999, invalid: 1 }), num)[0]).toBe("99% parsed");
  });

  it("shows only the RX count for a port the ingest box never reported on", () => {
    expect(portHealthParts(port({}), num)).toEqual(["1,234 rx"]);
  });

  it("shows a quiet port's rate of zero", () => {
    expect(portHealthParts(port({ pps: 0 }), num)).toEqual(["0 pkt/s", "1,234 rx"]);
  });
});
