// SPDX-License-Identifier: AGPL-3.0-or-later
// The position an ingested packet contributes: decoded from its payload, or pre-parsed by the ingest box,
// and in both cases on the globe.
import { describe, it, expect } from "vitest";
import { fixOf } from "../src/ingest.js";

const pkt = (payload: string, parsed?: unknown) => ({ src: "OE8APR-9", dst: "APRS", path: [], payload, parsed });

describe("ingest fix", () => {
  it("takes the decoded position", () => {
    expect(fixOf(pkt("!4704.41N/01526.27E>hi"))).toMatchObject({ lat: 47.0735, own: true });
  });

  it("refuses a decoded position past the poles or with minutes of 60 or more", () => {
    expect(fixOf(pkt("!9530.00N/01526.27E>"))).toBeNull();
    expect(fixOf(pkt("!4775.00N/01526.27E>"))).toBeNull();
  });

  it("takes a pre-parsed fix only when it is on the globe", () => {
    expect(fixOf(pkt(">status", { lat: 47.1, lon: 15.4, symbol: "/>" }))).toMatchObject({ lat: 47.1, lon: 15.4 });
    for (const parsed of [
      { lat: 123, lon: 15 },
      { lat: 47, lon: -200 },
      { lat: "47", lon: 15 },
      { lat: Number.NaN, lon: 15 },
      { lat: 47, lon: null },
    ])
      expect(fixOf(pkt(">status", parsed)), JSON.stringify(parsed)).toBeNull();
  });
});
