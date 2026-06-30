import { describe, it, expect } from "vitest";
import { ConnectedLink, parseAddr, type Ax25Frame, type LinkConfig } from "../src/index.js";

const A = parseAddr("OE8APR-1"), B = parseAddr("OE8XBM-7");
const dec = new TextDecoder(), enc = (s: string) => new TextEncoder().encode(s);

/** Two links wired through a queued (non-reentrant) medium + a fake clock; pump() drains in flight. */
function harness(cfg: Partial<LinkConfig> = {}) {
  const clk = { t: 0 };
  const queue: { to: "A" | "B"; f: Ax25Frame }[] = [];
  const got = { A: [] as string[], B: [] as string[] };
  let a!: ConnectedLink, b!: ConnectedLink;
  a = new ConnectedLink(A, B, { send: (f) => queue.push({ to: "B", f }), deliver: (i) => got.A.push(dec.decode(i)), state: () => {} }, cfg, () => clk.t);
  b = new ConnectedLink(B, A, { send: (f) => queue.push({ to: "A", f }), deliver: (i) => got.B.push(dec.decode(i)), state: () => {} }, cfg, () => clk.t);
  function pump(drop?: (to: "A" | "B", f: Ax25Frame) => boolean) {
    let n = 0;
    while (queue.length && n++ < 2000) {
      const { to, f } = queue.shift()!;
      if (drop?.(to, f)) continue;
      (to === "A" ? a : b).onReceive(f);
    }
  }
  const advance = (ms: number) => { clk.t += ms; a.poll(); b.poll(); };
  return { a, b, got, pump, advance, clk };
}

describe("ax25 connected-mode link (docs/25 P0)", () => {
  it("SABM/UA handshake connects both ends", () => {
    const h = harness();
    h.a.connect(); h.pump();
    expect(h.a.state).toBe("connected");
    expect(h.b.state).toBe("connected");
  });

  it("transfers I-frame data in both directions", () => {
    const h = harness(); h.a.connect(); h.pump();
    h.a.send(enc("hello B")); h.pump();
    h.b.send(enc("hi A")); h.pump();
    expect(h.got.B).toEqual(["hello B"]);
    expect(h.got.A).toEqual(["hi A"]);
  });

  it("delivers more frames than the window in order (windowing + acks)", () => {
    const h = harness({ window: 4 });
    h.a.connect(); h.pump();
    for (let i = 0; i < 6; i++) h.a.send(enc(`m${i}`));
    h.pump();
    expect(h.got.B).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("recovers a lost I-frame via T1 enquiry + retransmission", () => {
    const h = harness({ t1: 1000, window: 4 });
    h.a.connect(); h.pump();
    h.a.send(enc("only"));
    let dropped = false;
    h.pump((to, f) => { if (!dropped && to === "B" && f.type === "I") { dropped = true; return true; } return false; }); // lose it
    expect(h.got.B).toEqual([]);
    h.advance(1001);                 // T1 fires → A goes into recovery, polls
    h.pump();                        // enquiry/response → retransmit
    expect(h.got.B).toEqual(["only"]);
    expect(h.a.state).toBe("connected");
  });

  it("recovers an out-of-sequence frame via REJ", () => {
    const h = harness({ window: 4 });
    h.a.connect(); h.pump();
    h.a.send(enc("a0")); h.a.send(enc("a1")); h.a.send(enc("a2"));
    let dropped = false;
    h.pump((to, f) => { if (!dropped && to === "B" && f.type === "I" && f.ns === 1) { dropped = true; return true; } return false; });
    h.pump();                        // REJ from B → A retransmits from ns=1
    expect(h.got.B).toEqual(["a0", "a1", "a2"]);
  });

  it("DISC/UA releases the link", () => {
    const h = harness(); h.a.connect(); h.pump();
    h.a.disconnect(); h.pump();
    expect(h.a.state).toBe("disconnected");
    expect(h.b.state).toBe("disconnected");
  });

  it("gives up after N2 retries when the peer never answers SABM", () => {
    const h = harness({ t1: 1000, n2: 3 });
    h.a.connect();
    // never pump → B never answers; advance past N2 T1 expiries
    for (let i = 0; i < 5; i++) h.advance(1001);
    expect(h.a.state).toBe("disconnected");
  });
});
