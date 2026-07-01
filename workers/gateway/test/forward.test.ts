import { describe, it, expect } from "vitest";
import { normalizePartner } from "../src/forward.js";

describe("FBB forwarding partner normalizer (docs/29 F4)", () => {
  it("normalizes a full partner and uppercases call/HA", () => {
    const p = normalizePartner({
      call: "oe8xbm-1", ha: "oe8xbm.oe.eu", connectScript: "C NODE1\nC 3 DB0XYZ",
      proto: "axudp", intervalMin: 15, timebands: "0-6,22-23", requestReverse: false, msgtypes: "pb", maxBlock: 3,
    });
    expect(p).toEqual({
      call: "OE8XBM-1", ha: "OE8XBM.OE.EU", connectScript: "C NODE1\nC 3 DB0XYZ",
      proto: "axudp", intervalMin: 15, timebands: "0-6,22-23", requestReverse: false, msgtypes: "PB", maxBlock: 3, enabled: true,
    });
  });

  it("applies safe defaults for a bare partner", () => {
    expect(normalizePartner({ call: "DB0ABC" })).toEqual({
      call: "DB0ABC", ha: null, connectScript: "", proto: "rf-fbb",
      intervalMin: 30, timebands: "", requestReverse: true, msgtypes: "PBT", maxBlock: 5, enabled: true,
    });
  });

  it("rejects an invalid or missing callsign", () => {
    expect(normalizePartner({ call: "" })).toBeNull();
    expect(normalizePartner({ call: "toolongcall" })).toBeNull();
    expect(normalizePartner({})).toBeNull();
    expect(normalizePartner(null)).toBeNull();
  });

  it("clamps block size to the FBB spec cap (5) and interval to a day, drops bad protos/msgtypes", () => {
    const p = normalizePartner({ call: "OE1XYZ", maxBlock: 99, intervalMin: 99999, proto: "winlink", msgtypes: "PXZB!" })!;
    expect(p.maxBlock).toBe(5);
    expect(p.intervalMin).toBe(1440);
    expect(p.proto).toBe("rf-fbb");     // unknown transport → default
    expect(p.msgtypes).toBe("PB");       // only P/B/T survive, deduped
  });

  it("strips junk from timebands and dedups msgtypes", () => {
    expect(normalizePartner({ call: "OE1XYZ", timebands: "0-6; drop table" })!.timebands).toBe("0-6");
    expect(normalizePartner({ call: "OE1XYZ", msgtypes: "PPBB" })!.msgtypes).toBe("PB");
  });
});
