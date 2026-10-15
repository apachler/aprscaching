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

  it("carries the radio range a PHG works out to, or an RNG sends, and leaves the extension out of the comment", () => {
    expect(fixOf(pkt("!4704.41N/01526.27E#PHG5132 hilltop"))).toMatchObject({ rangeKm: 12.8, comment: "hilltop" });
    expect(fixOf(pkt("!4704.41N/01526.27E#RNG0050"))).toMatchObject({ rangeKm: 80.5 });
    expect(fixOf(pkt("!4704.41N/01526.27E>hi"))?.rangeKm).toBeUndefined();
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

  it("keeps what names the sending device: the tocall, or a Mic-E packet's device code and never its destination", () => {
    const withDst = (dst: string, payload: string) => fixOf({ src: "OE8APR-9", dst, path: [], payload });
    expect(withDst("apdw17-1", "!4704.41N/01526.27E>")?.device).toEqual({
      tocall: "APDW17",
      mice_prefix: null,
      mice_suffix: null,
    });
    expect(withDst("S32U6T", '`(_fn"Oj/]"4T}Mobile=')?.device).toEqual({
      tocall: null,
      mice_prefix: "]",
      mice_suffix: "=",
    });
    expect(withDst("S32U6T", '`(_fn"Oj/')?.device).toEqual({ tocall: null, mice_prefix: null, mice_suffix: null });
  });
});
