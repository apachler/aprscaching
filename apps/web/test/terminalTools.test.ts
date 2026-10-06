// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { Ax25Frame } from "@aprscaching/ax25";
import { TerminalSession, type Transport } from "@aprscaching/packet";
import { ToolHost, TX_CLOSED, type RemoteAnswer, type ToolEventPayload } from "@aprscaching/tools";
import { attachTerminalTools, LINK_PING_MIN_GAP_MS } from "../src/packet/terminalTools.js";

/**
 * The operator's terminal (A) wired to a far station's terminal (B) over a queued medium, with a ToolHost and an
 * in-process tool on the terminal surface that records its session events.
 */
function rig(opts: { remote?: (w: string, a: string) => RemoteAnswer | null } = {}) {
  const clk = { t: 0 };
  const queue: { to: "A" | "B"; f: Ax25Frame }[] = [];
  const onAir: Ax25Frame[] = [];
  let tools: ReturnType<typeof attachTerminalTools> | null = null;
  const tA: Transport = {
    send: (f) => {
      onAir.push(f);
      queue.push({ to: "B", f });
    },
  };
  const tB: Transport = { send: (f) => queue.push({ to: "A", f }) };
  const A = new TerminalSession(
    "OE8APR",
    tA,
    () => tools?.sync(),
    undefined,
    {},
    () => clk.t,
  );
  const B = new TerminalSession(
    "OE3ABC",
    tB,
    () => {},
    undefined,
    {},
    () => clk.t,
  );
  const pump = () => {
    for (let n = 0; queue.length && n < 2000; n++) {
      const { to, f } = queue.shift()!;
      (to === "A" ? A : B).onFrame(f);
    }
  };
  const log = vi.fn();
  const host = new ToolHost({ onLog: log });
  const events: { event: string; p: ToolEventPayload }[] = [];
  host.register({
    manifest: {
      name: "greeter",
      title: "Greeter",
      author: "X",
      version: "1",
      permissions: ["event", "ipc"],
      surfaces: ["terminal"],
    },
    activate: (ctx) => {
      ctx.on("on_connect", (p) => {
        events.push({ event: "on_connect", p });
        p.reply?.(`Welcome ${p.peerCall}`);
      });
      ctx.on("on_disconnect", (p) => events.push({ event: "on_disconnect", p }));
    },
  });
  host.setEnabled("greeter", true);
  const gate = { why: null as string | null };
  const notices: string[] = [];
  tools = attachTerminalTools({
    host,
    session: A,
    myCall: "OE8APR",
    txBlocked: () => gate.why,
    activeChannel: () => null,
    runRemote: (w, a) => opts.remote?.(w, a) ?? null,
    notice: (m) => notices.push(m),
    title: (t) => (t === "greeter" ? "Greeter" : t),
    now: () => clk.t,
  });
  const rx = () => B.channels[0]?.lines.filter((l) => l.dir === "rx" && l.text).map((l) => l.text) ?? [];
  return { A, B, pump, host, events, gate, notices, tools, rx, onAir, clk, log };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the packet terminal's sessions for the tools", () => {
  it("raises on_connect and on_disconnect for a station that connects, and replies on its channel", () => {
    const r = rig();
    const id = r.B.connect("OE8APR");
    r.pump();
    expect(r.events[0]).toMatchObject({
      event: "on_connect",
      p: { surface: "terminal", peerCall: "OE3ABC", myCall: "OE8APR", direction: "incoming", channel: 1 },
    });
    expect(r.rx()).toEqual(["Welcome OE3ABC"]);
    // the frame that carried it is listed under the tool's title
    const frame = r.onAir.find((f) => f.type === "I")!;
    expect(r.tools.featureOf(frame)).toBe("Tool Greeter");
    r.B.disconnect(id);
    r.pump();
    expect(r.events.map((e) => e.event)).toEqual(["on_connect", "on_disconnect"]);
  });

  it("raises on_connect without a reply on a channel this station opened", () => {
    const r = rig();
    r.A.connect("OE3ABC");
    r.pump();
    expect(r.events[0]!.p.direction).toBe("outgoing");
    expect(r.events[0]!.p.reply).toBeUndefined();
    expect(r.B.channels[0]!.lines.filter((l) => l.dir === "rx")).toEqual([]);
  });

  it("refuses a reply without the transmit gate", () => {
    const r = rig();
    r.gate.why = TX_CLOSED;
    r.B.connect("OE8APR");
    r.pump();
    expect(r.rx()).toEqual([]);
    expect(r.log).toHaveBeenCalledWith("greeter", `reply refused: ${TX_CLOSED}`);
  });

  it("ends every session for the tools when transmitting is switched off or the terminal closes", () => {
    const r = rig();
    r.B.connect("OE8APR");
    r.pump();
    r.A.allowTransmit(false);
    expect(r.events.map((e) => e.event)).toEqual(["on_connect", "on_disconnect"]);
  });

  it("runs a remote command a connected station types and sends its output back", async () => {
    const remote = vi.fn((w: string) => (w === "info" ? { tool: "info-responder", lines: ["Shack. 73!"] } : null));
    const r = rig({ remote });
    const id = r.B.connect("OE8APR");
    r.pump();
    r.B.send(id, "INFO");
    r.pump();
    await flush();
    r.pump();
    expect(remote).toHaveBeenCalledWith("info", "");
    expect(r.rx()).toEqual(["Welcome OE3ABC", "Shack. 73!"]);
  });

  it("never runs a command from the far end of a channel this station opened", async () => {
    const remote = vi.fn(() => ({ tool: "t", lines: ["x"] }));
    const r = rig({ remote });
    r.A.connect("OE3ABC");
    r.pump();
    r.B.send(r.B.channels[0]!.id, "info");
    r.pump();
    await flush();
    expect(remote).not.toHaveBeenCalled();
  });

  it("publishes link.rtt samples and answers link.ping.request with a poll", () => {
    const r = rig();
    const samples: unknown[] = [];
    const bus = r.host.toolBus("link-ping", ["ipc"]);
    bus.subscribe("link.rtt", (d) => samples.push(d));
    r.A.connect("OE3ABC");
    r.pump();
    const before = r.onAir.length;
    bus.emit("link.ping.request", {});
    expect(r.onAir.slice(before)).toMatchObject([{ type: "RR", command: true, pf: true }]);
    r.pump();
    expect(samples).toContainEqual({ ms: 0, kind: "poll", peerCall: "OE3ABC", channel: 1, surface: "terminal" });
    bus.emit("link.ping.request", {}); // too soon after the last
    expect(r.notices.at(-1)).toMatch(/ping held, one every/);
    r.clk.t += LINK_PING_MIN_GAP_MS;
    r.gate.why = TX_CLOSED;
    bus.emit("link.ping.request", {});
    expect(r.notices.at(-1)).toContain(TX_CLOSED);
  });

  it("says so when there is no channel to ping", () => {
    const r = rig();
    r.host.toolBus("link-ping", ["ipc"]).emit("link.ping.request", {});
    expect(r.notices).toEqual(["link-ping: no connected channel to ping"]);
  });

  it("stops answering the bus once disposed", () => {
    const r = rig();
    r.tools.dispose();
    r.host.toolBus("link-ping", ["ipc"]).emit("link.ping.request", {});
    expect(r.notices).toEqual([]);
  });
});
