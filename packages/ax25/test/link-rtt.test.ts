// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { ConnectedLink, parseAddr, type Ax25Frame } from "../src/index.js";

const A = parseAddr("OE8APR-1"),
  B = parseAddr("OE8XBM-7");
const enc = (s: string) => new TextEncoder().encode(s);

/** Two links whose medium delivers only when hopped, so the clock moves while frames are in flight. */
function timed() {
  const clk = { t: 0 };
  const queue: { to: "A" | "B"; f: Ax25Frame }[] = [];
  const rtt: [number, string][] = [];
  const a = new ConnectedLink(
    A,
    B,
    {
      send: (f) => queue.push({ to: "B", f }),
      deliver: () => {},
      state: () => {},
      rtt: (ms, k) => rtt.push([ms, k]),
    },
    {},
    () => clk.t,
  );
  const b = new ConnectedLink(
    B,
    A,
    { send: (f) => queue.push({ to: "A", f }), deliver: () => {}, state: () => {} },
    {},
    () => clk.t,
  );
  /** Deliver what is in flight, `ms` later each hop, until the medium is quiet. */
  const hop = (ms: number, drop?: (f: Ax25Frame) => boolean) => {
    for (let n = 0; queue.length && n < 50; n++) {
      clk.t += ms;
      for (const { to, f } of queue.splice(0)) if (!drop?.(f)) (to === "A" ? a : b).onReceive(f);
    }
  };
  return { a, b, clk, queue, rtt, hop };
}

describe("round-trip samples", () => {
  it("times an I-frame to the frame that acknowledges it", () => {
    const h = timed();
    h.a.connect();
    h.hop(100);
    h.rtt.length = 0;
    h.a.send(enc("hello"));
    h.hop(150);
    expect(h.rtt).toEqual([[300, "ack"]]);
  });

  it("times a poll to its final response, one poll at a time", () => {
    const h = timed();
    h.a.connect();
    h.hop(100);
    h.rtt.length = 0;
    expect(h.a.probe()).toBe(true);
    expect(h.queue.at(-1)?.f).toMatchObject({ type: "RR", command: true, pf: true });
    expect(h.a.probe()).toBe(false);
    h.hop(200);
    expect(h.rtt).toEqual([[400, "poll"]]);
    expect(h.a.state).toBe("connected");
    expect(h.a.probe()).toBe(true);
  });

  it("takes no sample from a retransmitted I-frame (Karn's rule)", () => {
    const h = timed();
    h.a.connect();
    h.hop(100);
    h.rtt.length = 0;
    h.a.send(enc("lost once"));
    h.hop(10, (f) => f.type === "I"); // the first copy is lost
    h.clk.t += 3000;
    h.a.poll(); // T1 polls; the answer asks for the I-frame again
    h.hop(50);
    expect(h.rtt.filter(([, k]) => k === "ack")).toEqual([]);
  });

  it("probes only a connected link", () => {
    expect(timed().a.probe()).toBe(false);
  });
});
