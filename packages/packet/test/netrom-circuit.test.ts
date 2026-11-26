// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { NetromCircuit, NR_MAX_INFO, NR_MAX_REASSEMBLY, type NrTpPacket } from "../src/netrom-circuit.js";
import { NrOp, NR_MORE } from "../src/netrom-wire.js";

const A = (call: string, ssid = 0) => ({ call, ssid });
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Wire two circuits over a deferred (queued) packet channel — the same re-entrancy-safe pattern as the
 *  AX.25 loopback: a packet one circuit emits is delivered to the other on a later pump(), never inline. */
function pair() {
  const q: Array<{ to: "a" | "b"; p: NrTpPacket }> = [];
  const rxA: Uint8Array[] = [];
  const rxB: Uint8Array[] = [];
  const a = new NetromCircuit(
    {
      send: (p) => q.push({ to: "b", p }),
      deliver: (i) => rxA.push(i),
      state: () => {},
    },
    { index: 1, id: 10 },
    { user: A("OE1XYZ"), node: A("OE8NOD", 1) },
  );
  const b = new NetromCircuit(
    {
      send: (p) => q.push({ to: "a", p }),
      deliver: (i) => rxB.push(i),
      state: () => {},
    },
    { index: 2, id: 20 },
  );
  const pump = (guard = 5000) => {
    let n = 0;
    while (q.length && n++ < guard) {
      const { to, p } = q.shift()!;
      (to === "a" ? a : b).onPacket(p.tp, p.info);
    }
  };
  return { a, b, rxA, rxB, pump };
}

describe("NET/ROM L4 circuit", () => {
  it("connects (ConnReq/ConnAck) and negotiates the window", () => {
    const { a, b, pump } = pair();
    a.connect(4);
    pump();
    expect(a.state).toBe("connected");
    expect(b.state).toBe("connected");
  });

  it("carries an in-sequence message end-to-end", () => {
    const { a, rxB, pump } = pair();
    a.connect();
    pump();
    a.send(new TextEncoder().encode("hello over netrom"));
    pump();
    expect(rxB.map(dec)).toEqual(["hello over netrom"]);
  });

  it("fragments and reassembles a message larger than 236 bytes (more-follows)", () => {
    const { a, rxB, pump } = pair();
    a.connect(8);
    pump();
    const big = "X".repeat(NR_MAX_INFO * 2 + 50); // 3 fragments
    a.send(new TextEncoder().encode(big));
    pump();
    expect(rxB).toHaveLength(1); // reassembled into a single delivered message
    expect(dec(rxB[0]!)).toBe(big);
    expect(dec(rxB[0]!).length).toBe(NR_MAX_INFO * 2 + 50);
  });

  it("carries data both directions and disconnects cleanly", () => {
    const { a, b, rxA, rxB, pump } = pair();
    a.connect();
    pump();
    a.send(new TextEncoder().encode("ping"));
    b.send(new TextEncoder().encode("pong"));
    pump();
    expect(rxB.map(dec)).toEqual(["ping"]);
    expect(rxA.map(dec)).toEqual(["pong"]);
    a.disconnect();
    pump();
    expect(a.state).toBe("disconnected");
    expect(b.state).toBe("disconnected");
  });

  it("decodes the originating user/node from a ConnReq (node accepting a circuit)", () => {
    let captured: NrTpPacket | null = null;
    const c = new NetromCircuit(
      {
        send: (p) => {
          captured = p;
        },
        deliver: () => {},
        state: () => {},
      },
      { index: 5, id: 99 },
      { user: A("OE3ABC", 7), node: A("OE8NOD", 1) },
    );
    c.connect();
    const origin = NetromCircuit.originOf(captured!.info)!;
    expect(origin.user).toEqual({ call: "OE3ABC", ssid: 7 });
    expect(origin.node).toEqual({ call: "OE8NOD", ssid: 1 });
  });
});

// With a lossy channel, a circuit must retransmit on T1 and eventually tear itself down —
// never wedge forever. Uses an injected clock so time is deterministic.
describe("NET/ROM circuit timers", () => {
  it("retransmits a lost ConnReq, then gives up after n2 and disconnects", () => {
    let t = 0;
    const sends: NrTpPacket[] = [];
    const states: string[] = [];
    // a black hole: nothing is ever delivered back → every ConnReq times out
    const c = new NetromCircuit(
      { send: (p) => sends.push(p), deliver: () => {}, state: (s) => states.push(s) },
      { index: 3, id: 30 },
      { user: A("OE1XYZ"), node: A("OE8NOD", 1) },
      { clock: () => t, t1Ms: 1000, n2: 3 },
    );
    c.connect(4);
    expect(sends.length).toBe(1); // initial ConnReq
    for (let i = 0; i < 3; i++) {
      t += 1000;
      c.poll();
    } // three T1 expiries → three retransmits
    expect(sends.length).toBe(4); // 1 initial + 3 retransmits
    t += 1000;
    c.poll(); // n2 exhausted → tear down
    expect(c.state).toBe("disconnected");
    expect(states).toContain("disconnected");
  });

  it("stops retransmitting once the ConnAck arrives", () => {
    let t = 0;
    const { a, b, pump } = pair();
    // rebuild `a` with an injected clock (pair() uses the default); simplest: drive a fresh connected pair
    a.connect(4);
    pump();
    expect(a.state).toBe("connected");
    // once connected with nothing outstanding, poll() is a no-op (no wedge, no spurious frames)
    const before: NrTpPacket[] = [];
    const c = new NetromCircuit(
      { send: (p) => before.push(p), deliver: () => {}, state: () => {} },
      { index: 9, id: 9 },
      { user: A("OE1XYZ"), node: A("OE8NOD", 1) },
      { clock: () => t, t1Ms: 1000, n2: 3 },
    );
    c.connect(4); // ConnReq sent, timer armed
    // simulate the ack: feed a ConnAck back
    c.onPacket(
      { circuitIndex: 2, circuitId: 2, txSeq: 2, rxSeq: 2, opcode: 0x2 /* ConnAck */, flags: 0 },
      new Uint8Array([4]),
    );
    const n = before.length;
    t += 5000;
    c.poll();
    c.poll(); // long after T1 would have fired
    expect(before.length).toBe(n); // no retransmit — the timer was disarmed on connect
    expect(b.state).toBe("connected");
  });
});

describe("NET/ROM circuit bounds", () => {
  /** An accepted inbound circuit and what it sends, on a settable clock. */
  function accepted() {
    const clock = { t: 0 };
    const sent: NrTpPacket[] = [];
    const states: string[] = [];
    const c = new NetromCircuit(
      { send: (p) => sent.push(p), deliver: () => {}, state: (s) => states.push(s) },
      { index: 1, id: 1 },
      undefined,
      { clock: () => clock.t },
    );
    c.onPacket({ opcode: NrOp.ConnReq, flags: 0, circuitIndex: 7, circuitId: 7, txSeq: 0, rxSeq: 0 }, Uint8Array.of(4));
    return { c, sent, states, clock };
  }

  it("tears the circuit down when a message passes 8 KiB without its last fragment", () => {
    const { c, sent } = accepted();
    const frag = new Uint8Array(NR_MAX_INFO).fill(0x41);
    for (let i = 0; i < 1000; i++)
      c.onPacket({ opcode: NrOp.Info, flags: NR_MORE, circuitIndex: 1, circuitId: 1, txSeq: i & 0xff, rxSeq: 0 }, frag);
    expect(c.state).toBe("disconnecting");
    expect(sent.some((p) => p.tp.opcode === NrOp.DiscReq)).toBe(true);
    expect((c as unknown as { rxFrag: Uint8Array[] }).rxFrag.length).toBe(0);
  });

  it("delivers a message just under the cap", () => {
    const got: Uint8Array[] = [];
    const c = new NetromCircuit({ send: () => {}, deliver: (b) => got.push(b), state: () => {} }, { index: 1, id: 1 });
    c.onPacket({ opcode: NrOp.ConnReq, flags: 0, circuitIndex: 7, circuitId: 7, txSeq: 0, rxSeq: 0 }, Uint8Array.of(4));
    const n = Math.floor(NR_MAX_REASSEMBLY / NR_MAX_INFO);
    for (let i = 0; i < n; i++)
      c.onPacket(
        { opcode: NrOp.Info, flags: i < n - 1 ? NR_MORE : 0, circuitIndex: 1, circuitId: 1, txSeq: i, rxSeq: 0 },
        new Uint8Array(NR_MAX_INFO),
      );
    expect(got.map((b) => b.length)).toEqual([n * NR_MAX_INFO]);
  });

  it("closes a circuit idle for 15 minutes, and not one that keeps talking", () => {
    const NR_IDLE_MS = 15 * 60_000;
    const { c, clock } = accepted();
    clock.t = NR_IDLE_MS - 1000;
    c.onPacket({ opcode: NrOp.InfoAck, flags: 0, circuitIndex: 1, circuitId: 1, txSeq: 0, rxSeq: 0 }, new Uint8Array());
    clock.t += NR_IDLE_MS - 1;
    c.poll();
    expect(c.state).toBe("connected");
    clock.t += 1;
    c.poll();
    expect(c.state).toBe("disconnecting");
  });
});
