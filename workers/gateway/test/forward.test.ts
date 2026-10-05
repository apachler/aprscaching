// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { normalizePartner, fbbFromRow, inboundRow } from "../src/forward.js";
import { bidFor } from "../src/bbs.js";

describe("FBB forwarding partner normalizer", () => {
  it("normalizes a full partner and uppercases call/HA", () => {
    const p = normalizePartner({
      call: "oe8xbm-1",
      ha: "oe8xbm.oe.eu",
      connectScript: "C NODE1\nC 3 DB0XYZ",
      proto: "axudp",
      intervalMin: 15,
      timebands: "0-6,22-23",
      requestReverse: false,
      msgtypes: "pb",
      maxBlock: 3,
    });
    expect(p).toEqual({
      call: "OE8XBM-1",
      ha: "OE8XBM.OE.EU",
      connectScript: "C NODE1\nC 3 DB0XYZ",
      proto: "axudp",
      intervalMin: 15,
      timebands: "0-6,22-23",
      requestReverse: false,
      msgtypes: "PB",
      maxBlock: 3,
      enabled: true,
      federation: null,
    });
  });

  it("keeps federation unset unless the save names it", () => {
    expect(normalizePartner({ call: "DB0ABC" })!.federation).toBeNull();
    expect(normalizePartner({ call: "DB0ABC", federation: true })!.federation).toBe(true);
    expect(normalizePartner({ call: "DB0ABC", federation: false })!.federation).toBe(false);
  });

  it("applies safe defaults for a bare partner", () => {
    expect(normalizePartner({ call: "DB0ABC" })).toEqual({
      call: "DB0ABC",
      ha: null,
      connectScript: "",
      proto: "rf-fbb",
      intervalMin: 30,
      timebands: "",
      requestReverse: true,
      msgtypes: "PBT",
      maxBlock: 5,
      enabled: true,
      federation: null,
    });
  });

  it("rejects an invalid or missing callsign", () => {
    expect(normalizePartner({ call: "" })).toBeNull();
    expect(normalizePartner({ call: "toolongcall" })).toBeNull();
    expect(normalizePartner({})).toBeNull();
    expect(normalizePartner(null)).toBeNull();
  });

  it("clamps block size to the FBB spec cap (5) and interval to a day, drops bad protos/msgtypes", () => {
    const p = normalizePartner({
      call: "OE1XYZ",
      maxBlock: 99,
      intervalMin: 99999,
      proto: "winlink",
      msgtypes: "PXZB!",
    })!;
    expect(p.maxBlock).toBe(5);
    expect(p.intervalMin).toBe(1440);
    expect(p.proto).toBe("rf-fbb"); // unknown transport → default
    expect(p.msgtypes).toBe("PB"); // only P/B/T survive, deduped
  });

  it("strips junk from timebands and dedups msgtypes", () => {
    expect(normalizePartner({ call: "OE1XYZ", timebands: "0-6; drop table" })!.timebands).toBe("0-6");
    expect(normalizePartner({ call: "OE1XYZ", msgtypes: "PPBB" })!.msgtypes).toBe("PB");
  });
});

describe("FBB forwarding-pool mappers", () => {
  it("maps a local row to the FBB wire shape (subject → title, T rides as P, at = routing hint)", () => {
    const wire = fbbFromRow(
      {
        id: 42,
        bid: "42_oe.aprscaching.net",
        type: "T",
        from_call: "OE8APR",
        to_call: "DL1ABC",
        subject: "hello",
        body: "hi there",
      },
      "oe.aprscaching.net",
      "DB0XYZ.OE.EU",
    );
    expect(wire).toEqual({
      type: "P",
      from: "OE8APR",
      at: "DB0XYZ.OE.EU",
      to: "DL1ABC",
      bid: "42_oe.aprscaching.net",
      title: "hello",
      body: "hi there",
    });
  });

  it("splits a hierarchical to-address into single-token wire fields (FB lines are space-delimited)", () => {
    const wire = fbbFromRow(
      {
        id: 1,
        bid: "1_oe.ia",
        type: "P",
        from_call: "OE1AAA",
        to_call: "OE1TST @ OE1BBB.OE.EU",
        subject: "interop",
        body: "x",
      },
      "oe.ia",
      "PARTNER.HA",
    );
    // "OE1TST @ OE1BBB.OE.EU" in the to field would emit an unparseable 9-token FB proposal and
    // deadlock the session against any real FBB/BPQ peer — recipient and @BBS must split.
    expect(wire.to).toBe("OE1TST");
    expect(wire.at).toBe("OE1BBB.OE.EU");
    expect(`FB ${wire.type} ${wire.from} ${wire.at} ${wire.to} ${wire.bid} 1`.split(/\s+/)).toHaveLength(7);
  });

  it("synthesizes a BID from the id and the BBS call when the row has none, keeps B type", () => {
    const wire = fbbFromRow(
      { id: 7, bid: null, type: "B", from_call: "OE8APR", to_call: "ALL", subject: null, body: "net sat" },
      "OE8APR",
      "OE",
    );
    expect(wire.bid).toBe("7_OE8APR");
    expect(wire.type).toBe("B");
    expect(wire.title).toBe("");
  });

  it("builds an inbound insert row (uppercased, origin stamped) and rejects incomplete input", () => {
    const row = inboundRow(
      { type: "P", from: "dl1abc", to: "oe8apr", bid: "9_db0", title: "re", body: "thanks" },
      "rf-fbb",
      1000,
    );
    expect(row).toEqual({
      bid: "9_db0",
      type: "P",
      from: "DL1ABC",
      to: "OE8APR",
      title: "re",
      body: "thanks",
      posted: 1000,
      origin: "rf-fbb",
    });
    expect(inboundRow({ from: "X", to: "Y" }, "rf-fbb", 1000)).toBeNull(); // no bid / body
    expect(inboundRow({ bid: "1", from: "X", to: "Y", body: "" }, "rf-fbb", 1000)).not.toBeNull(); // empty body is valid
  });
});

describe("FBB BIDs", () => {
  it("fit F6FBB's 12 characters as <id in base 36>_<BBS call>, whatever the call's length", () => {
    expect(bidFor(1, "OE8APR")).toBe("1_OE8APR");
    expect(bidFor(1295, "OE8APR")).toBe("ZZ_OE8APR");
    for (const call of ["K1A", "OE8APR"])
      for (const id of [1, 36 ** 5 - 1, 36 ** 5, 2 ** 40]) expect(bidFor(id, call).length).toBeLessThanOrEqual(12);
    expect(bidFor(36 ** 5, "OE8APR")).toBe("0_OE8APR"); // a six-character call leaves five digits, then wraps
  });
});
