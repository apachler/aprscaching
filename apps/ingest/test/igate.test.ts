// SPDX-License-Identifier: AGPL-3.0-or-later
// The APRS-IS -> RF direction of the IGate transmits, so it gates a message to RF only when its transmit
// switch says so; without one it receives only.
import { describe, it, expect } from "vitest";
import { parseTNC2 } from "@aprscaching/aprs";
import { Igate } from "../src/igate.js";
import type { KissTnc } from "../src/kiss.js";

function igate(canTx?: () => boolean) {
  const sent: string[] = [];
  const kiss = { send: (f: { payload: string }) => (sent.push(f.payload), true) } as unknown as KissTnc;
  const g = new Igate(kiss, { host: "127.0.0.1", port: 1, call: "OE8APR-10", pass: "1", canTx });
  // the addressee was heard locally on RF
  g.onRf(parseTNC2("OE8XYZ-7>APRS,WIDE1-1:>on air")!);
  return { g, sent };
}
const MSG = "OE5ABC>APRS,TCPIP*,qAC,T2AUSTRIA::OE8XYZ-7 :hello{1";

describe("Igate APRS-IS -> RF", () => {
  it("transmits nothing without a transmit switch", () => {
    const { g, sent } = igate();
    g.onIsLine(MSG);
    expect(sent).toEqual([]);
  });

  it("transmits nothing while the switch is off", () => {
    const { g, sent } = igate(() => false);
    g.onIsLine(MSG);
    expect(sent).toEqual([]);
  });

  it("gates a message for a locally heard station when the switch is on", () => {
    const { g, sent } = igate(() => true);
    g.onIsLine(MSG);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(":OE8XYZ-7 :hello{1");
  });
});
