// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  digipeat,
  dedupeKey,
  shouldRxIgate,
  rxIgateLine,
  txIgateTarget,
  txIgateFrame,
  pathBlocksTxGating,
  messageAddressee,
  pathBlocksGating,
  igatePayload,
} from "../src/index.js";
import type { ParsedFrame } from "../src/index.js";

const f = (path: string[], src = "OE1ABC", payload = "!4704.41N/01526.27E>hi", dst = "APRS"): ParsedFrame => ({
  src,
  dst,
  path,
  payload,
  raw: "",
});

describe("digipeater (new n-N paradigm)", () => {
  const opts = { mycall: "OE8XXX", aliases: new Set(["WIDE1", "WIDE2"]) };
  it("decrements without inserting when the path already holds 8 digipeaters", () => {
    const full = ["D1*", "D2*", "D3*", "D4*", "D5*", "D6*", "D7*", "WIDE2-2"];
    expect(digipeat(f(full), opts)!.path).toEqual([...full.slice(0, 7), "WIDE2-1"]);
  });
  it("replaces an exact alias, SSID included, and never decrements it", () => {
    const eoc = { mycall: "OE8XXX", aliases: new Set(["WIDE1", "WIDE2", "EOC-1", "RELAY"]) };
    expect(digipeat(f(["EOC-1"]), eoc)!.path).toEqual(["OE8XXX*"]);
    expect(digipeat(f(["RELAY", "WIDE2-1"]), eoc)!.path).toEqual(["OE8XXX*", "WIDE2-1"]);
    expect(digipeat(f(["EOC-2"]), eoc)).toBeNull();
  });
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
    expect(digipeat(f(["WIDE2-2"], "OE8XXX"), opts)).toBeNull();
    expect(digipeat(f(["WIDE2-2"], "OE8XXX-0"), opts)).toBeNull();
  });
  it("repeats another SSID of our base call like any station: the operator's handheld or car", () => {
    expect(digipeat(f(["WIDE2-2"], "OE8XXX-9"), opts)!.path).toEqual(["OE8XXX*", "WIDE2-1"]);
    expect(digipeat(f(["OE8XXX-1*", "WIDE2-1"]), opts)!.path).toEqual(["OE8XXX-1*", "OE8XXX*"]);
    expect(digipeat(f(["OE8XXX-1"]), opts)).toBeNull(); // routed through another station, not us
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
    // the destination's SSID is left out too
    expect(dedupeKey(f(["WIDE2-1"], "OE1ABC", "x", "APRS-1"))).toBe(dedupeKey(f(["WIDE2-1"], "OE1ABC", "x", "APRS")));
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
    // a carried packet that came from APRS-IS stays off it
    expect(shouldRxIgate(f([], "OE1ABC", "}W2XYZ>APRS,TCPIP,OE1ABC*:>hello"), "OE8XXX")).toBe(false);
    expect(shouldRxIgate(f([], "OE8XXX"), "OE8XXX")).toBe(false);
    expect(shouldRxIgate(f([], "OE8XXX-0"), "OE8XXX")).toBe(false);
    expect(pathBlocksGating(["WIDE1-1", "NOGATE"])).toBe(true);
  });
  it("relays the info field up to its first CR or LF, and nothing when that leaves it empty", () => {
    const fr = f(["WIDE2-1"], "OE1ABC", ">status\rN0CALL>APRS:extra\r\n");
    expect(shouldRxIgate(fr, "OE8XXX")).toBe(true);
    expect(rxIgateLine(fr, "OE8XXX")).toBe("OE1ABC>APRS,WIDE2-1,qAR,OE8XXX:>status");
    expect(rxIgateLine(f([], "OE1ABC", ">a\nb"), "OE8XXX")).toBe("OE1ABC>APRS,qAR,OE8XXX:>a");
    expect(rxIgateLine(f([], "OE1ABC", ">a\0b"), "OE8XXX")).toBe("OE1ABC>APRS,qAR,OE8XXX:>a");
    expect(shouldRxIgate(f([], "OE1ABC", "\r\n>later"), "OE8XXX")).toBe(false);
    expect(igatePayload(">plain")).toBe(">plain");
  });
});

describe("RX-IGate per APRS 1.2", () => {
  it("gates the packet a third-party frame carries, with the encapsulation removed", () => {
    const tp = f(["WIDE2-1"], "K1ABC", "}W2XYZ>APRS,K1ABC*:>hello");
    expect(shouldRxIgate(tp, "N0GATE")).toBe(true);
    expect(rxIgateLine(tp, "N0GATE")).toBe("W2XYZ>APRS,K1ABC*,qAR,N0GATE:>hello");
  });
  it("does not unwrap a carried packet that is third-party traffic in turn, nor an empty one", () => {
    expect(shouldRxIgate(f([], "K1ABC", "}W2XYZ>APRS:}A>B:>x"), "N0GATE")).toBe(false);
    expect(shouldRxIgate(f([], "K1ABC", "}not a packet"), "N0GATE")).toBe(false);
  });
  it("gates another SSID of the gate's base call: that is another station", () => {
    expect(shouldRxIgate(f(["WIDE1-1"], "OE8APR-9"), "OE8APR-10")).toBe(true);
  });
  it("does not gate a general query", () => {
    expect(shouldRxIgate(f(["WIDE1-1"], "OE1ABC", "?APRS?"), "OE8XXX")).toBe(false);
  });
  it("keeps one has-been-repeated mark, on the last used hop", () => {
    expect(rxIgateLine(f(["K2RVW-1*", "WIDE1*", "WIDE2-2"]), "N0GATE")).toBe(
      "OE1ABC>APRS,K2RVW-1,WIDE1*,WIDE2-2,qAR,N0GATE:!4704.41N/01526.27E>hi",
    );
  });
  it("marks a receive-only gate with qAO", () => {
    expect(rxIgateLine(f([]), "N0GATE", { receiveOnly: true })).toBe("OE1ABC>APRS,qAO,N0GATE:!4704.41N/01526.27E>hi");
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
  it("gates the ordinary TCPIP* path of an APRS-IS client message", () => {
    const msg = f(["TCPIP*", "qAC", "T2AUSTRIA"], "DL1ABC", ":OE5LOC   :hi there{1");
    expect(txIgateTarget(msg, "OE8XXX", local)).toBe("OE5LOC");
  });
  it("honours the IS -> RF do-not-gate tokens", () => {
    for (const tok of ["TCPXX*", "NOGATE", "RFONLY"])
      expect(txIgateTarget(f([tok, "qAX", "T2AUSTRIA"], "DL1ABC", ":OE5LOC   :hi{1"), "OE8XXX", local)).toBeNull();
    expect(pathBlocksTxGating(["TCPIP*", "qAC", "T2AUSTRIA"])).toBe(false);
  });
  it("gates acks and rejects, which the RF station retries until it hears", () => {
    expect(txIgateTarget(f(["TCPIP*"], "DL1ABC", ":OE5LOC   :ack1"), "OE8XXX", local)).toBe("OE5LOC");
    expect(txIgateTarget(f(["TCPIP*"], "DL1ABC", ":OE5LOC   :rej1"), "OE8XXX", local)).toBe("OE5LOC");
  });
  it("treats other SSIDs of the gate's base call as other stations", () => {
    const heard = (cs: string) => cs === "N0GATE-7" || cs === "K1ABC";
    expect(txIgateTarget(f(["TCPIP*"], "W2XYZ", ":N0GATE-7 :hi{1"), "N0GATE-10", heard)).toBe("N0GATE-7");
    expect(txIgateTarget(f(["TCPIP*"], "N0GATE-5", ":K1ABC    :hi{1"), "N0GATE-10", heard)).toBe("K1ABC");
    expect(txIgateTarget(f(["TCPIP*"], "W2XYZ", ":N0GATE-10:hi{1"), "N0GATE-10", heard)).toBeNull();
  });
  it("won't gate non-messages", () => {
    expect(txIgateTarget(f([], "DL1ABC", "!4704.41N/01526.27E>pos"), "OE8XXX", local)).toBeNull();
  });
  it("won't gate when the sender is heard locally too", () => {
    const both = (cs: string) => cs === "OE5LOC" || cs === "OE5NBR";
    expect(txIgateTarget(f(["TCPIP*"], "OE5NBR", ":OE5LOC   :hi{1"), "OE8XXX", both)).toBeNull();
  });
  it("builds a third-party frame under the IGate's own call", () => {
    const msg = f(["TCPIP*", "qAC", "T2AUSTRIA"], "DL1ABC", ":OE5LOC   :hi there{1");
    expect(txIgateFrame(msg, "oe8xxx-10")).toEqual({
      src: "OE8XXX-10",
      dst: "APZACG",
      path: [],
      payload: "}DL1ABC>APRS,TCPIP,OE8XXX-10*::OE5LOC   :hi there{1",
    });
    expect(txIgateFrame(msg, "OE8XXX-10", { path: ["WIDE1-1"] }).path).toEqual(["WIDE1-1"]);
  });
  it("messageAddressee parses the 9-char addressee", () => {
    expect(messageAddressee(":OE5LOC   :hi{1")).toBe("OE5LOC");
    expect(messageAddressee("!notmsg")).toBeNull();
  });
});
