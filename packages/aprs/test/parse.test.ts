import { describe, it, expect } from "vitest";
import { parseTNC2, classifyQ, parsePosition, haversineMeters } from "../src/index.js";

describe("TNC2", () => {
  it("parses a basic frame", () => {
    const f = parseTNC2("OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:=4704.12N/01525.30E>test")!;
    expect(f.src).toBe("OE8APR-9");
    expect(f.path).toContain("qAR");
  });
  it("ignores comments", () => expect(parseTNC2("# server msg")).toBeNull());
});
describe("q-construct", () => {
  it("flags RF-gated", () => {
    const r = classifyQ(["WIDE1-1", "qAR", "OE8XXX"]);
    expect(r.heardVia).toBe("rf"); expect(r.igateCall).toBe("OE8XXX");
  });
  it("flags internet injection", () =>
    expect(classifyQ(["TCPIP*", "qAC", "T2SERVER"]).heardVia).toBe("aprs_is"));
});
describe("position + geo", () => {
  it("parses lat/lon", () => {
    const p = parsePosition("=4704.12N/01525.30E>")!;
    expect(p.lat).toBeCloseTo(47.069, 2);
    expect(p.lon).toBeCloseTo(15.421, 2);
  });
  it("haversine ~0 same point", () => expect(haversineMeters(47, 15, 47, 15)).toBeLessThan(1));
});
