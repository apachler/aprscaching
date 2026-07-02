// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { TerminalSession, type Transport } from "../src/index.js";
import type { Ax25Frame } from "@aprsweb/ax25";

/** Two terminal sessions wired through a queued medium + a fake clock (cf. the ax25 link tests). */
function harness() {
  const clk = { t: 0 };
  const queue: { to: "A" | "B"; f: Ax25Frame }[] = [];
  const tA: Transport = { send: (f) => queue.push({ to: "B", f }) };
  const tB: Transport = { send: (f) => queue.push({ to: "A", f }) };
  const A = new TerminalSession("OE8APR-1", tA, () => {}, undefined, { t1: 1000 }, () => clk.t);
  const B = new TerminalSession("OE8XBM-7", tB, () => {}, undefined, { t1: 1000 }, () => clk.t);
  const pump = () => { let n = 0; while (queue.length && n++ < 2000) { const { to, f } = queue.shift()!; (to === "A" ? A : B).onFrame(f); } };
  const advance = (ms: number) => { clk.t += ms; A.poll(); B.poll(); };
  return { A, B, pump, advance };
}

describe("terminal session core (docs/25 P1)", () => {
  it("connect() opens a channel and the peer auto-accepts the incoming call", () => {
    const h = harness();
    const id = h.A.connect("OE8XBM-7"); h.pump();
    expect(h.A.channels.find((c) => c.id === id)?.state).toBe("connected");
    expect(h.B.channels).toHaveLength(1);
    expect(h.B.channels[0]!.state).toBe("connected");
    expect(h.B.channels[0]!.remoteCall).toBe("OE8APR-1");
  });

  it("send() delivers a line into the peer's channel", () => {
    const h = harness();
    const id = h.A.connect("OE8XBM-7"); h.pump();
    h.A.send(id, "hello B"); h.pump();
    expect(h.B.channels[0]!.lines.some((l) => l.dir === "rx" && l.text === "hello B")).toBe(true);
    expect(h.A.channels.find((c) => c.id === id)!.lines.some((l) => l.dir === "tx" && l.text === "hello B")).toBe(true);
  });

  it("records all heard traffic in the monitor, classified", () => {
    const h = harness();
    h.A.connect("OE8XBM-7"); h.pump();
    expect(h.B.monitor.length).toBeGreaterThan(0);
    expect(h.B.monitor.some((m) => m.src === "OE8APR-1" && m.dst === "OE8XBM-7")).toBe(true);
  });

  it("disconnect() releases both ends", () => {
    const h = harness();
    const id = h.A.connect("OE8XBM-7"); h.pump();
    h.A.disconnect(id); h.pump();
    expect(h.A.channels.find((c) => c.id === id)!.state).toBe("disconnected");
    expect(h.B.channels[0]!.state).toBe("disconnected");
  });
});
