// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { TerminalSession, type Transport } from "../src/index.js";
import type { Ax25Frame } from "@aprscaching/ax25";

/** Two terminal sessions wired through a queued medium + a fake clock (cf. the ax25 link tests). */
function harness() {
  const clk = { t: 0 };
  const queue: { to: "A" | "B"; f: Ax25Frame }[] = [];
  const tA: Transport = { send: (f) => queue.push({ to: "B", f }) };
  const tB: Transport = { send: (f) => queue.push({ to: "A", f }) };
  const A = new TerminalSession(
    "OE8APR-1",
    tA,
    () => {},
    undefined,
    { t1: 1000 },
    () => clk.t,
  );
  const B = new TerminalSession(
    "OE8XBM-7",
    tB,
    () => {},
    undefined,
    { t1: 1000 },
    () => clk.t,
  );
  const pump = () => {
    let n = 0;
    while (queue.length && n++ < 2000) {
      const { to, f } = queue.shift()!;
      (to === "A" ? A : B).onFrame(f);
    }
  };
  const advance = (ms: number) => {
    clk.t += ms;
    A.poll();
    B.poll();
  };
  return { A, B, pump, advance };
}

describe("terminal session core", () => {
  it("connect() opens a channel and the peer auto-accepts the incoming call", () => {
    const h = harness();
    const id = h.A.connect("OE8XBM-7");
    h.pump();
    expect(h.A.channels.find((c) => c.id === id)?.state).toBe("connected");
    expect(h.B.channels).toHaveLength(1);
    expect(h.B.channels[0]!.state).toBe("connected");
    expect(h.B.channels[0]!.remoteCall).toBe("OE8APR-1");
  });

  it("send() delivers a line into the peer's channel", () => {
    const h = harness();
    const id = h.A.connect("OE8XBM-7");
    h.pump();
    h.A.send(id, "hello B");
    h.pump();
    expect(h.B.channels[0]!.lines.some((l) => l.dir === "rx" && l.text === "hello B")).toBe(true);
    expect(h.A.channels.find((c) => c.id === id)!.lines.some((l) => l.dir === "tx" && l.text === "hello B")).toBe(true);
  });

  it("records all heard traffic in the monitor, classified", () => {
    const h = harness();
    h.A.connect("OE8XBM-7");
    h.pump();
    expect(h.B.monitor.length).toBeGreaterThan(0);
    expect(h.B.monitor.some((m) => m.src === "OE8APR-1" && m.dst === "OE8XBM-7")).toBe(true);
  });

  it("disconnect() releases both ends", () => {
    const h = harness();
    const id = h.A.connect("OE8XBM-7");
    h.pump();
    h.A.disconnect(id);
    h.pump();
    expect(h.A.channels.find((c) => c.id === id)!.state).toBe("disconnected");
    expect(h.B.channels[0]!.state).toBe("disconnected");
  });
});

describe("a station that may not transmit only listens", () => {
  it("refuses to connect and sends no frame", () => {
    const sent: Ax25Frame[] = [];
    const s = new TerminalSession("OE8APR-1", { send: (f) => sent.push(f) }, () => {});
    s.allowTransmit(false);
    expect(() => s.connect("OE8XBM-7")).toThrow(/verify your callsign/);
    expect(sent).toHaveLength(0);
    expect(s.canTransmit).toBe(false);
  });

  it("does not answer an incoming connect, but the monitor still records it", () => {
    const h = harness();
    h.B.allowTransmit(false);
    h.A.connect("OE8XBM-7");
    h.pump();
    expect(h.B.channels).toHaveLength(0);
    expect(h.B.monitor.length).toBeGreaterThan(0);
    expect(h.A.channels[0]!.state).not.toBe("connected");
  });

  it("drops open connections without sending when transmit is turned off", () => {
    const h = harness();
    const id = h.A.connect("OE8XBM-7");
    h.pump();
    expect(h.A.channels.find((c) => c.id === id)?.state).toBe("connected");
    h.A.allowTransmit(false);
    expect(h.A.channels.find((c) => c.id === id)?.state).toBe("disconnected");
    h.A.send(id, "hello");
    h.advance(5000);
    h.pump();
    expect(h.B.channels[0]!.lines.some((l) => l.text.includes("hello"))).toBe(false);
  });
});

describe("terminal session events for the host", () => {
  it("marks who opened each channel", () => {
    const h = harness();
    h.A.connect("OE8XBM-7");
    h.pump();
    expect(h.A.channels[0]!.direction).toBe("outgoing");
    expect(h.B.channels[0]!.direction).toBe("incoming");
  });

  it("hands each received line to the listener", () => {
    const h = harness();
    const lines: string[] = [];
    h.B.listener = { line: (ch, text) => lines.push(`${ch.remoteCall}: ${text}`) };
    const id = h.A.connect("OE8XBM-7");
    h.pump();
    h.A.send(id, "info");
    h.pump();
    expect(lines).toEqual(["OE8APR-1: info"]);
  });

  it("probes a connected channel and reports the round trip", () => {
    const h = harness();
    const samples: string[] = [];
    h.A.listener = { rtt: (ch, ms, kind) => samples.push(`${ch.remoteCall} ${kind} ${ms}`) };
    const id = h.A.connect("OE8XBM-7");
    h.pump();
    expect(h.A.probe(id)).toBe(true);
    h.pump();
    expect(samples).toEqual(["OE8XBM-7 poll 0"]);
    h.A.allowTransmit(false);
    expect(h.A.probe(id)).toBe(false);
  });
});
