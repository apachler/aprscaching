// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { normalizePartner, fbbFromRow, inboundRow } from "../src/forward.js";

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
    });
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

  it("synthesizes a BID from id_instance when the row has none, keeps B type", () => {
    const wire = fbbFromRow(
      { id: 7, bid: null, type: "B", from_call: "OE8APR", to_call: "ALL", subject: null, body: "net sat" },
      "oe.net",
      "OE",
    );
    expect(wire.bid).toBe("7_oe.net");
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
