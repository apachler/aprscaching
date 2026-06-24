import { describe, it, expect } from "vitest";
import { digipeat, dedupeKey, shouldRxIgate, rxIgateLine, txIgateTarget, messageAddressee, pathBlocksGating } from "../src/index.js";
import type { ParsedFrame } from "../src/index.js";

const f = (path: string[], src = "OE1ABC", payload = "!4704.41N/01526.27E>hi", dst = "APRS"): ParsedFrame =>
  ({ src, dst, path, payload, raw: "" });

describe("digipeater (new n-N paradigm)", () => {
  const opts = { mycall: "OE8XXX", aliases: new Set(["WIDE1", "WIDE2"]) };
  it("inserts our call and decrements WIDE2-2 -> WIDE2-1", () => {
    expect(digipeat(f(["WIDE2-2"]), opts)!.path).toEqual(["OE8XXX*", "WIDE2-1"]);
  });
  it("replaces the alias on the last hop (WIDE2-1 -> us)", () => {
    expect(digipeat(f(["OE9YYY*", "WIDE2-1"]), opts)!.path).toEqual(["OE9YYY*", "OE8XXX*"]);
  });
  it("handles a fill-in WIDE1-1", () => {
    expect(digipeat(f(["WIDE1-1"]), opts)!.path).toEqual(["OE8XXX*"]);
  });
  it("repeats a frame explicitly routed through us", () => {
    expect(digipeat(f(["OE8XXX"]), opts)!.path).toEqual(["OE8XXX*"]);
  });
  it("does not repeat our own transmission", () => {
    expect(digipeat(f(["WIDE2-2"], "OE8XXX-9"), opts)).toBeNull();
  });
  it("does not repeat twice (loop guard)", () => {
    expect(digipeat(f(["OE8XXX*", "WIDE2-1"], "OE1ABC"), { ...opts, mycall: "OE8XXX" })).toBeNull();
  });
  it("ignores aliases we don't serve and exhausted paths", () => {
    expect(digipeat(f(["WIDE5-2"]), opts)).toBeNull();
    expect(digipeat(f(["WIDE2-2*"]), opts)).toBeNull();
  });
  it("dedupe key ignores the path", () => {
    expect(dedupeKey(f(["WIDE2-2"]))).toBe(dedupeKey(f(["WIDE1-1"])));
  });
});

describe("RX-IGate", () => {
  it("gates a normal RF frame and builds a qAR line", () => {
    const fr = f(["WIDE2-1"]);
    expect(shouldRxIgate(fr, "OE8XXX")).toBe(true);
    expect(rxIgateLine(fr, "OE8XXX")).toBe("OE1ABC>APRS,WIDE2-1,qAR,OE8XXX:!4704.41N/01526.27E>hi");
  });
  it("refuses NOGATE/RFONLY/TCPIP paths, third-party, and our own", () => {
    expect(shouldRxIgate(f(["WIDE2-1", "RFONLY"]), "OE8XXX")).toBe(false);
    expect(shouldRxIgate(f(["TCPIP*"]), "OE8XXX")).toBe(false);
    expect(shouldRxIgate(f([], "OE1ABC", "}third>party:data"), "OE8XXX")).toBe(false);
    expect(shouldRxIgate(f([], "OE8XXX-1"), "OE8XXX")).toBe(false);
    expect(pathBlocksGating(["WIDE1-1", "NOGATE"])).toBe(true);
  });
});

describe("TX-IGate", () => {
  const local = (cs: string) => cs === "OE5LOC";
  it("gates a message to a locally-heard station", () => {
    const msg = f([], "DL1ABC", ":OE5LOC   :hi there{1");
    expect(txIgateTarget(msg, "OE8XXX", local)).toBe("OE5LOC");
  });
  it("won't gate to a station not heard locally", () => {
    expect(txIgateTarget(f([], "DL1ABC", ":OE9FAR   :hello{1"), "OE8XXX", local)).toBeNull();
  });
  it("won't gate non-messages or bare acks", () => {
    expect(txIgateTarget(f([], "DL1ABC", "!4704.41N/01526.27E>pos"), "OE8XXX", local)).toBeNull();
    expect(txIgateTarget(f([], "DL1ABC", ":OE5LOC   :ack1"), "OE8XXX", local)).toBeNull();
  });
  it("messageAddressee parses the 9-char addressee", () => {
    expect(messageAddressee(":OE5LOC   :hi{1")).toBe("OE5LOC");
    expect(messageAddressee("!notmsg")).toBeNull();
  });
});
