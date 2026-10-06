// SPDX-License-Identifier: AGPL-3.0-or-later
// With several radio ports, the digipeater shares one duplicate window across them (a frame two ports on one
// channel both hear is repeated once), and the IGate gates a message on the port that last heard its addressee.
import { describe, it, expect } from "vitest";
import { parseTNC2 } from "@aprscaching/aprs";
import { Digipeater } from "../src/digipeater.js";
import { Igate } from "../src/igate.js";
import type { KissTnc } from "../src/kiss.js";

describe("several radio ports", () => {
  it("the digipeater repeats a frame heard on two ports only once", () => {
    const sent: string[] = [];
    const port = (name: string) => ({ send: () => (sent.push(name), true) });
    const recent = new Map<string, number>();
    const a = new Digipeater(port("a"), { mycall: "OE8APR-10", aliases: new Set(["WIDE1"]), recent });
    const b = new Digipeater(port("b"), { mycall: "OE8APR-10", aliases: new Set(["WIDE1"]), recent });
    const f = parseTNC2("OE8XYZ-7>APRS,WIDE1-1:>on air")!;
    a.onFrame(f);
    b.onFrame(f);
    expect(sent).toEqual(["a"]);
  });

  it("the IGate gates a message on the port that last heard its addressee", () => {
    const onA: string[] = [];
    const onB: string[] = [];
    const a = { send: (f: { payload: string }) => (onA.push(f.payload), true) };
    const b = { send: (f: { payload: string }) => (onB.push(f.payload), true) };
    const g = new Igate(a as unknown as KissTnc, {
      host: "127.0.0.1",
      port: 1,
      call: "OE8APR-10",
      pass: "1",
      canTx: () => true,
    });
    g.onRf(parseTNC2("OE8XYZ-7>APRS,WIDE1-1:>on air")!, b);
    g.onIsLine("OE5ABC>APRS,TCPIP*,qAC,T2AUSTRIA::OE8XYZ-7 :hello{1");
    expect(onB).toHaveLength(1);
    expect(onA).toEqual([]);
  });
});
