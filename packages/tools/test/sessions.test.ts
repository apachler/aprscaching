// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import {
  REPLY_MAX,
  REPLY_TEXT_MAX,
  REPLY_TTL_MS,
  REMOTE_QUEUE_MAX,
  SessionEvents,
  ToolHost,
  TX_CLOSED,
  type Capability,
  type RemoteAnswer,
  type SurfaceSession,
  type ToolEventPayload,
} from "../src/index.js";

/** An in-process tool that records its session events and keeps their payloads. */
function eventTool(host: ToolHost, name: string, permissions: Capability[], surfaces = ["terminal"]) {
  const seen: { event: string; p: ToolEventPayload }[] = [];
  host.register({
    manifest: { name, title: name, author: "X", version: "1", permissions, surfaces: surfaces as never },
    activate: (ctx) => {
      ctx.on("on_connect", (p) => seen.push({ event: "on_connect", p }));
      ctx.on("on_disconnect", (p) => seen.push({ event: "on_disconnect", p }));
    },
  });
  host.setEnabled(name, true);
  return seen;
}

const session = (over: Partial<SurfaceSession> = {}): SurfaceSession => ({
  channel: 1,
  peerCall: "OE3ABC",
  myCall: "OE8APR",
  direction: "incoming",
  open: true,
  ...over,
});

function surface(opts: { remote?: (w: string, a: string) => RemoteAnswer | null; owns?: string[] } = {}) {
  let now = 1_000_000;
  const log = vi.fn();
  const host = new ToolHost({ onLog: log, now: () => now });
  const sent: [number, string, string][] = [];
  let gate: string | null = null;
  const ev = new SessionEvents({
    host,
    surface: "terminal",
    send: (ch, text, tool) => sent.push([ch, text, tool]),
    txBlocked: () => gate,
    runRemote: (w, a) => opts.remote?.(w, a) ?? null,
    ownsWord: (w) => (opts.owns ?? []).includes(w),
    log,
    now: () => now,
  });
  return {
    host,
    ev,
    sent,
    log,
    close: (why: string | null) => (gate = why),
    tick: (ms: number) => (now += ms),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("on_connect and on_disconnect", () => {
  it("raise once per session, with the session's calls, channel, surface and direction", () => {
    const s = surface();
    const seen = eventTool(s.host, "bell", ["event"]);
    s.ev.sync([session()]);
    s.ev.sync([session()]); // still up: nothing new
    s.ev.sync([session({ open: false })]);
    expect(seen.map((x) => x.event)).toEqual(["on_connect", "on_disconnect"]);
    expect(seen[0]!.p).toMatchObject({
      surface: "terminal",
      channel: 1,
      peerCall: "OE3ABC",
      myCall: "OE8APR",
      direction: "incoming",
    });
  });

  it("raise on_disconnect for every open session when the surface closes", () => {
    const s = surface();
    const seen = eventTool(s.host, "bell", ["event"]);
    s.ev.sync([session(), session({ channel: 2, direction: "outgoing" })]);
    s.ev.closeAll();
    expect(seen.filter((x) => x.event === "on_disconnect").map((x) => x.p.channel)).toEqual([1, 2]);
  });

  it("reach only tools granted 'event' on the session's surface", () => {
    const s = surface();
    const elsewhere = eventTool(s.host, "map-only", ["event"], ["map"]);
    s.host.register({
      manifest: { name: "no-grant", title: "x", author: "X", version: "1", permissions: [], surfaces: ["terminal"] },
      activate: (ctx) => ctx.on("on_connect", () => {}),
    });
    expect(s.host.setEnabled("no-grant", true).error).toMatch(/permission 'event' not granted/);
    s.ev.sync([session()]);
    expect(elsewhere).toEqual([]);
  });
});

describe("a tool's reply", () => {
  it("answers an incoming session through the surface, under the tool's name, one line within the limit", () => {
    const s = surface();
    const seen = eventTool(s.host, "greeter", ["event"]);
    s.ev.sync([session()]);
    seen[0]!.p.reply!("Welcome\r\nOE3ABC " + "x".repeat(400));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]![0]).toBe(1);
    expect(s.sent[0]![1]).toMatch(/^Welcome OE3ABC x+$/);
    expect(s.sent[0]![1]).toHaveLength(REPLY_TEXT_MAX);
    expect(s.sent[0]![2]).toBe("greeter");
  });

  it("is held to REPLY_MAX lines and REPLY_TTL_MS per event", () => {
    const s = surface();
    const seen = eventTool(s.host, "greeter", ["event"]);
    s.ev.sync([session()]);
    for (let i = 0; i < REPLY_MAX + 2; i++) seen[0]!.p.reply!(`line ${i}`);
    expect(s.sent).toHaveLength(REPLY_MAX);
    s.ev.sync([session({ open: false })]);
    s.ev.sync([session({ channel: 2 })]);
    s.tick(REPLY_TTL_MS + 1);
    seen.at(-1)!.p.reply!("too late");
    expect(s.sent).toHaveLength(REPLY_MAX);
    expect(s.log).toHaveBeenCalledWith("greeter", expect.stringMatching(/reply window has closed/));
  });

  it("is refused without a verified callsign and this tab's consent, and the tool's log says why", () => {
    const s = surface();
    const seen = eventTool(s.host, "greeter", ["event"]);
    s.ev.sync([session()]);
    s.close(TX_CLOSED);
    seen[0]!.p.reply!("Welcome");
    expect(s.sent).toEqual([]);
    expect(s.log).toHaveBeenCalledWith("greeter", `reply refused: ${TX_CLOSED}`);
  });

  it("is refused once the session has closed", () => {
    const s = surface();
    const seen = eventTool(s.host, "greeter", ["event"]);
    s.ev.sync([session()]);
    s.ev.sync([]);
    seen[0]!.p.reply!("still there?");
    expect(s.sent).toEqual([]);
    expect(s.log).toHaveBeenCalledWith("greeter", "reply refused: the session has closed");
  });

  it("is not offered on a session this station opened", () => {
    const s = surface();
    const seen = eventTool(s.host, "greeter", ["event"]);
    s.ev.sync([session({ direction: "outgoing" })]);
    expect(seen[0]!.p.direction).toBe("outgoing");
    expect(seen[0]!.p.reply).toBeUndefined();
  });
});

describe("remote commands", () => {
  const answers = (w: string, a: string): RemoteAnswer | null =>
    w === "info"
      ? { tool: "info-responder", lines: ["Shack station. 73!"] }
      : w === "note"
        ? { tool: "away-note", lines: [`saved: ${a}`] }
        : w === "long"
          ? { tool: "chatty", lines: Array.from({ length: 10 }, (_, i) => `line ${i}`) }
          : null;

  it("run a word a tool opened to connected stations and send its output back on the session", async () => {
    const s = surface({ remote: answers });
    s.ev.sync([session()]);
    s.ev.line(1, "INFO");
    s.ev.line(1, "note back at 18z");
    await flush();
    expect(s.sent).toEqual([
      [1, "Shack station. 73!", "info-responder"],
      [1, "saved: back at 18z", "away-note"],
    ]);
  });

  it("send at most REPLY_MAX lines of a command's output", async () => {
    const s = surface({ remote: answers });
    s.ev.sync([session()]);
    s.ev.line(1, "long");
    await flush();
    expect(s.sent.map((x) => x[1])).toEqual(["line 0", "line 1", "line 2", "line 3"]);
  });

  it("ignore a line that is not a command word", async () => {
    const runRemote = vi.fn(answers);
    const s = surface({ remote: runRemote });
    s.ev.sync([session()]);
    for (const l of ["/info", "Info: from the far end", "", "73!"]) s.ev.line(1, l);
    await flush();
    expect(runRemote).not.toHaveBeenCalled();
  });

  it("leave a word the surface answers itself to the surface", async () => {
    const runRemote = vi.fn(answers);
    const s = surface({ remote: runRemote, owns: ["info"] });
    s.ev.sync([session()]);
    s.ev.line(1, "info");
    await flush();
    expect(runRemote).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
  });

  it("never run from a session this station opened", async () => {
    const runRemote = vi.fn(answers);
    const s = surface({ remote: runRemote });
    s.ev.sync([session({ direction: "outgoing" })]);
    s.ev.line(1, "info");
    await flush();
    expect(runRemote).not.toHaveBeenCalled();
  });

  it("send nothing without the transmit gate", async () => {
    const s = surface({ remote: answers });
    s.ev.sync([session()]);
    s.close(TX_CLOSED);
    s.ev.line(1, "info");
    await flush();
    expect(s.sent).toEqual([]);
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining(TX_CLOSED));
  });

  it("run one at a time on a session, in order, with a few waiting at most", async () => {
    const releases: ((a: RemoteAnswer) => void)[] = [];
    const runRemote = vi.fn(() => new Promise<RemoteAnswer>((r) => releases.push(r)));
    const s = surface();
    const ev = new SessionEvents({
      host: s.host,
      surface: "terminal",
      send: (ch, text, tool) => s.sent.push([ch, text, tool]),
      txBlocked: () => null,
      runRemote,
    });
    ev.sync([session()]);
    for (let i = 0; i < REMOTE_QUEUE_MAX + 2; i++) ev.line(1, `slow ${i}`);
    await flush();
    expect(runRemote).toHaveBeenCalledTimes(1);
    for (let i = 0; i < REMOTE_QUEUE_MAX + 2; i++) {
      releases[i]?.({ tool: "t", lines: [`done ${i}`] });
      await flush();
      await flush();
    }
    expect(runRemote).toHaveBeenCalledTimes(REMOTE_QUEUE_MAX);
    expect(s.sent.map((x) => x[1])).toEqual(["done 0", "done 1", "done 2", "done 3"]);
  });

  it("through the host: only a remote tool's commands opened to peers answer", () => {
    const host = new ToolHost();
    host.register({
      manifest: {
        name: "peer-tool",
        title: "x",
        author: "X",
        version: "1",
        permissions: ["command"],
        surfaces: ["terminal"],
        remote: true,
      },
      activate: (ctx) => {
        ctx.registerCommand("info", () => ["hi"]);
        ctx.registerCommand("setinfo", () => ["set"], { remote: false });
      },
    });
    host.register({
      manifest: {
        name: "local-tool",
        title: "x",
        author: "X",
        version: "1",
        permissions: ["command"],
        surfaces: ["terminal"],
      },
      activate: (ctx) => ctx.registerCommand("secret", () => ["no"]),
    });
    host.setEnabled("peer-tool", true);
    host.setEnabled("local-tool", true);
    expect(host.runCommand("info", "", "terminal", { remote: true })).toEqual(["hi"]);
    expect(host.runCommand("setinfo", "", "terminal", { remote: true })).toBeNull();
    expect(host.runCommand("secret", "", "terminal", { remote: true })).toBeNull();
    expect(host.runCommand("secret", "", "terminal")).toEqual(["no"]);
  });
});

describe("the link topics on the bus", () => {
  it("link.rtt is the app's alone; a tool may publish link.ping.request, which the app hears", () => {
    const host = new ToolHost();
    const heard = vi.fn();
    const stop = host.hostSubscribe("link.ping.request", heard);
    const bus = host.toolBus("link-ping", ["ipc"]);
    expect(() => bus.emit("link.rtt", { ms: 1 })).toThrow(/reserved/);
    bus.emit("link.ping.request", {});
    expect(heard).toHaveBeenCalledWith({}, "link-ping");
    const samples: unknown[] = [];
    bus.subscribe("link.rtt", (d) => samples.push(d));
    host.hostEmit("link.rtt", { ms: 420 });
    expect(samples).toEqual([{ ms: 420 }]);
    stop();
    bus.emit("link.ping.request", {});
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("an in-process tool cannot publish link.rtt or provide a link. service", () => {
    const host = new ToolHost();
    host.register({
      manifest: { name: "fake-rtt", title: "x", author: "X", version: "1", permissions: ["ipc"], surfaces: ["web"] },
      activate: (ctx) => ctx.emit("link.rtt", { ms: 1 }),
    });
    host.register({
      manifest: { name: "fake-svc", title: "x", author: "X", version: "1", permissions: ["ipc"], surfaces: ["web"] },
      activate: (ctx) => ctx.provideService("link.ping.request", () => 1),
    });
    expect(host.setEnabled("fake-rtt", true).error).toMatch(/topic "link.rtt" is reserved/);
    expect(host.setEnabled("fake-svc", true).error).toMatch(/service "link.ping.request" is reserved/);
  });
});
