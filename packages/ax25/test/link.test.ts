// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { ConnectedLink, parseAddr, encodeFrame, decodeFrame, type Ax25Frame, type LinkConfig } from "../src/index.js";

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

describe("ax25 modulo-128 (SABME) + SREJ (docs/25 P0.b)", () => {
  it("connects with SABME and reports the extended modulus on both ends", () => {
    const h = harness({ modulo: 128 });
    h.a.connect(); h.pump();
    expect(h.a.state).toBe("connected"); expect(h.b.state).toBe("connected");
    expect(h.a.extended).toBe(true); expect(h.b.extended).toBe(true);
    expect(h.a.modulo).toBe(128);
  });

  it("delivers more than 8 outstanding frames — proving 7-bit sequence numbers", () => {
    const h = harness({ modulo: 128, window: 16 });
    h.a.connect(); h.pump();
    const msgs = Array.from({ length: 12 }, (_, i) => `x${i}`);
    for (const m of msgs) h.a.send(enc(m));
    h.pump();
    expect(h.got.B).toEqual(msgs);           // 12 > mod-8 would have stalled/wrapped; mod-128 carries them
  });

  it("round-trips every frame through the extended WIRE codec (encode/decode, extended)", () => {
    // wire the medium through encodeFrame/decodeFrame using each link's own extended flag.
    const clk = { t: 0 };
    const queue: { to: "A" | "B"; bytes: Uint8Array; ext: boolean }[] = [];
    const got = { A: [] as string[], B: [] as string[] };
    let a!: ConnectedLink, b!: ConnectedLink;
    a = new ConnectedLink(A, B, { send: (f) => queue.push({ to: "B", bytes: encodeFrame(f), ext: !!f.extended }), deliver: (i) => got.A.push(dec.decode(i)), state: () => {} }, { modulo: 128, window: 8 }, () => clk.t);
    b = new ConnectedLink(B, A, { send: (f) => queue.push({ to: "A", bytes: encodeFrame(f), ext: !!f.extended }), deliver: (i) => got.B.push(dec.decode(i)), state: () => {} }, { modulo: 128, window: 8 }, () => clk.t);
    const pump = () => { let n = 0; while (queue.length && n++ < 2000) { const { to, bytes, ext } = queue.shift()!; (to === "A" ? a : b).onReceive(decodeFrame(bytes, ext)!); } };
    a.connect(); pump();
    expect(a.extended).toBe(true);
    for (let i = 0; i < 10; i++) a.send(enc(`w${i}`));
    pump();
    expect(got.B).toEqual(Array.from({ length: 10 }, (_, i) => `w${i}`));
  });

  it("recovers a single out-of-sequence frame via SREJ — retransmitting only that frame", () => {
    const h = harness({ srej: true, window: 6 });
    h.a.connect(); h.pump();
    for (let i = 0; i < 5; i++) h.a.send(enc(`s${i}`));
    let dropped = false, retransmits = 0;
    // drop s2 once on the way to B; then count how many times B re-receives an I-frame with ns===2.
    h.pump((to, f) => {
      if (to === "B" && f.type === "I" && f.ns === 2) {
        if (!dropped) { dropped = true; return true; }   // lose s2 the first time
        retransmits++;                                   // count the SREJ-driven retransmit(s)
      }
      return false;
    });
    h.pump();
    expect(h.got.B).toEqual(["s0", "s1", "s2", "s3", "s4"]);   // reassembled in order
    expect(retransmits).toBe(1);                               // ONLY s2 came back, not s2..s4 (go-back-N)
  });
});
