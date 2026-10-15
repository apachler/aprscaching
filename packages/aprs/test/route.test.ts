// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { splitPath, isGenericHop, isRfQConstruct } from "../src/index.js";

describe("splitPath", () => {
  it("marks every entry up to the last `*` as used and the rest as requests no digipeater took", () => {
    const p = splitPath("OE6XGR-2,WIDE1*,WIDE2-1,qAR,OE6XGR-10");
    expect(p.digis).toEqual([
      { call: "OE6XGR-2", used: true, generic: false },
      { call: "WIDE1", used: true, generic: true },
      { call: "WIDE2-1", used: false, generic: true },
    ]);
    expect(p).toMatchObject({ q: "qAR", qVia: ["OE6XGR-10"], internet: false });
  });

  it("reads an untouched path as all requests", () => {
    expect(splitPath(["WIDE1-1", "WIDE2-1"]).digis.map((d) => d.used)).toEqual([false, false]);
  });

  it("reads TCPIP* as written to APRS-IS, not as a digipeater", () => {
    const p = splitPath("TCPIP*,qAC,T2AUSTRIA");
    expect(p).toEqual({ digis: [], internet: true, q: "qAC", qVia: ["T2AUSTRIA"] });
  });

  it("names the IGate of qAO and the server of qAS, qAX and qAU", () => {
    expect(splitPath("WIDE2-1,qAO,OE8ABC-10").qVia).toEqual(["OE8ABC-10"]);
    expect(splitPath("qAS,T2GRAZ").q).toBe("qAS");
    expect(splitPath("TCPXX*,qAX,T2GRAZ")).toMatchObject({ internet: true, q: "qAX", qVia: ["T2GRAZ"] });
    expect(splitPath("qAU,T2GRAZ")).toMatchObject({ q: "qAU", qVia: ["T2GRAZ"] });
  });

  it("keeps every server a qAI trace names", () => {
    expect(splitPath("TCPIP*,qAI,T2A,T2B").qVia).toEqual(["T2A", "T2B"]);
  });

  it("reads an on-air frame with no q-construct", () => {
    expect(splitPath("OE6XGR-2*,WIDE2-1")).toEqual({
      digis: [
        { call: "OE6XGR-2", used: true, generic: false },
        { call: "WIDE2-1", used: false, generic: true },
      ],
      internet: false,
      qVia: [],
    });
  });

  it("takes an empty or missing path as a direct transmission", () => {
    expect(splitPath("")).toEqual({ digis: [], internet: false, qVia: [] });
    expect(splitPath(null)).toEqual({ digis: [], internet: false, qVia: [] });
  });
});

describe("isGenericHop", () => {
  it("tells generic requests from callsigns", () => {
    for (const g of ["WIDE1-1", "WIDE2", "RELAY", "TRACE3-3", "OE2-2", "NOGATE"]) expect(isGenericHop(g)).toBe(true);
    for (const c of ["OE6XGR-2", "DB0ABC", "K1ABC-10", "W1AW"]) expect(isGenericHop(c)).toBe(false);
  });
});

describe("isRfQConstruct", () => {
  it("is true for the constructs an IGate adds to an on-air frame", () => {
    expect(["qAR", "qAr", "qAO", "qAo"].every(isRfQConstruct)).toBe(true);
    expect(["qAC", "qAS", "qAX", "qAU", "qAI", undefined].some(isRfQConstruct)).toBe(false);
  });
});
