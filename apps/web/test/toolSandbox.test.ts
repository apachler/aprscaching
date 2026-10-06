// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { BEACON_MIN_INTERVAL_SEC, ToolHost, TX_CLOSED, type Capability } from "@aprscaching/tools";
import {
  compileRules,
  connectSources,
  frameCsp,
  frameSource,
  MAX_EXACT_RULES,
  MAX_SCAN_RULES,
  parseFrameMessage,
  REPLY_MAX,
  REPLY_TEXT_MAX,
  REPLY_TTL_MS,
  SandboxBridge,
  sandboxTool,
  workerPayload,
} from "../src/tools/sandbox.js";

describe("the tool frame's CSP", () => {
  it("blocks every connection when the tool reaches nothing", () => {
    const csp = frameCsp([]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src blob:");
  });
  it("lists exactly the origins the tool may reach", () => {
    expect(frameCsp(["https://a.example", "wss://b.example"])).toContain(
      "connect-src https://a.example wss://b.example",
    );
  });
});

describe("connectSources", () => {
  const app = ["https://aprscaching.net", "https://gw.example.net"];
  it("is empty without the network grant", () => {
    expect(connectSources(["command"], ["https://a.example"], app)).toEqual([]);
  });
  it("keeps the manifest's origins and drops the app's own, in http and ws form", () => {
    expect(
      connectSources(
        ["network"],
        ["https://a.example", "https://gw.example.net", "wss://gw.example.net", "wss://aprscaching.net"],
        app,
      ),
    ).toEqual(["https://a.example"]);
  });
});

describe("frameSource", () => {
  it("carries the CSP and keeps the worker source inside its script element", () => {
    const html = frameSource(frameCsp([]));
    expect(html).toContain(`http-equiv="Content-Security-Policy" content="default-src 'none';`);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
  it("escapes a quote in the CSP attribute", () => {
    expect(frameSource('a"b')).toContain('content="a&quot;b"');
  });
});

describe("parseFrameMessage", () => {
  it("drops anything that is not a known message", () => {
    for (const bad of [null, 1, "loaded", {}, { type: "nope" }, { type: "cmdResult", id: "1", lines: [] }])
      expect(parseFrameMessage(bad)).toBeNull();
    expect(parseFrameMessage({ type: "call", id: 1 })).toBeNull();
    expect(parseFrameMessage({ type: "emit", topic: 3 })).toBeNull();
    expect(parseFrameMessage({ type: "on", event: "on_everything" })).toBeNull();
    expect(parseFrameMessage({ type: "tx", id: 1 })).toBeNull();
    expect(parseFrameMessage({ type: "tx", info: ">x" })).toBeNull();
    expect(parseFrameMessage({ type: "reply", replyId: "1", text: "x" })).toBeNull();
    expect(parseFrameMessage({ type: "provide", name: 1 })).toBeNull();
    expect(parseFrameMessage({ type: "log", msg: {} })).toBeNull();
  });
  it("keeps only well-formed contributions from a loaded tool", () => {
    const m = parseFrameMessage({
      type: "loaded",
      commands: ["hello", 4, null],
      remoteOff: ["hello", 1],
      colourRules: [{ srcPrefix: "OE", colorVar: "--st-user", hidden: "yes" }, 7],
      panel: { title: "P" },
      decoders: [{ id: "rot13", label: "ROT13", kind: "text", sample: "uryyb", placeholder: 4 }, { id: 1 }],
    });
    expect(m).toEqual({
      type: "loaded",
      commands: ["hello"],
      remoteOff: ["hello"],
      colourRules: [
        {
          src: undefined,
          srcPrefix: "OE",
          dstPrefix: undefined,
          textIncludes: undefined,
          colorVar: "--st-user",
          hidden: false,
        },
      ],
      panel: { title: "P" },
      decoders: [{ id: "rot13", label: "ROT13", kind: "text", sample: "uryyb" }],
    });
  });
  it("turns command result lines into strings and caps a log line", () => {
    expect(parseFrameMessage({ type: "cmdResult", id: 2, lines: [1, "a"] })).toEqual({
      type: "cmdResult",
      id: 2,
      lines: ["1", "a"],
    });
    expect((parseFrameMessage({ type: "log", msg: "x".repeat(900) }) as { msg: string }).msg).toHaveLength(300);
  });
  it("caps colour rules to the exact and scanned limits", () => {
    const rules = Array.from({ length: MAX_EXACT_RULES + MAX_SCAN_RULES + 50 }, (_, i) => ({ src: `N${i}` }));
    expect((parseFrameMessage({ type: "colours", rules }) as { rules: unknown[] }).rules).toHaveLength(
      MAX_EXACT_RULES + MAX_SCAN_RULES,
    );
  });
});

describe("compileRules", () => {
  it("matches a callsign exactly first, then the prefix and text rules in order", () => {
    const c = compileRules([
      { src: "OE8APR-9", colorVar: "--warn" },
      { srcPrefix: "OE", colorVar: "--st-user" },
      { textIncludes: "WX", hidden: true },
      { colorVar: "--never" }, // matches on nothing: dropped
    ]);
    expect(c({ src: "oe8apr-9", dst: "APRS", text: "" })).toEqual({ colorVar: "--warn", hidden: false });
    expect(c({ src: "OE8APR", dst: "APRS", text: "" })).toEqual({ colorVar: "--st-user", hidden: false });
    expect(c({ src: "DL1X", dst: "APRS", text: "WX report" })).toEqual({ colorVar: undefined, hidden: true });
    expect(c({ src: "DL1X", dst: "APRS", text: "" })).toBeNull();
  });
  it("drops a colour that is not a custom property", () => {
    expect(compileRules([{ src: "A1A", colorVar: "red; x: y" }])({ src: "A1A", dst: "", text: "" })).toEqual({
      colorVar: undefined,
      hidden: false,
    });
  });
});

describe("workerPayload", () => {
  it("keeps the surface's strings and plain station data, never a function", () => {
    const p = workerPayload({
      surface: "terminal",
      peerCall: "OE3ABC",
      text: "x".repeat(600),
      channel: 2,
      station: { roles: ["bbs"] },
      reply: () => undefined,
      secret: { toString: () => "no" },
    });
    expect(p).toEqual({
      surface: "terminal",
      peerCall: "OE3ABC",
      text: "x".repeat(512),
      channel: 2,
      station: { roles: ["bbs"] },
    });
  });
});

/** A tool in a bridge registered with a real ToolHost, switched on; `sent` collects what goes to its worker. */
function sandboxed(
  permissions: Capability[],
  hostOpts: ConstructorParameters<typeof ToolHost>[0] = {},
  name = "sb",
  host = new ToolHost(hostOpts),
) {
  const sent: Record<string, unknown>[] = [];
  let now = 1_000_000;
  const bridge = new SandboxBridge((m) => sent.push(m as Record<string, unknown>), permissions, { now: () => now });
  host.register(
    sandboxTool(
      { name, title: name, author: "X", version: "1", permissions, surfaces: ["web", "terminal", "map"] },
      bridge,
    ),
  );
  host.setEnabled(name, true);
  return { host, bridge, sent, tick: (ms: number) => (now += ms) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const last = (sent: Record<string, unknown>[], type: string) => sent.filter((m) => m.type === type).at(-1);

describe("SandboxBridge — every request goes through the tool's own context", () => {
  it("forwards a hooked event to the worker without its reply callback", () => {
    const { host, bridge, sent } = sandboxed(["monitor"]);
    bridge.receive({ type: "on", event: "on_frame" });
    host.dispatch("on_frame", { peerCall: "OE8XBM-7", source: "RF", dst: "APRS", text: ">hi" });
    expect(last(sent, "event")).toEqual({
      type: "event",
      event: "on_frame",
      payload: { peerCall: "OE8XBM-7", source: "RF", dst: "APRS", text: ">hi" },
    });
  });

  it("hooks no event the tool was not granted", () => {
    const onLog = vi.fn();
    const { host, bridge, sent } = sandboxed(["command"], { onLog });
    bridge.receive({ type: "on", event: "on_frame" });
    bridge.receive({ type: "on", event: "on_connect" });
    host.dispatch("on_frame", { peerCall: "OE8XBM-7" });
    host.dispatch("on_connect", { peerCall: "OE8XBM-7" });
    expect(sent.filter((m) => m.type === "event")).toEqual([]);
    expect(onLog).toHaveBeenCalledWith("sb", expect.stringMatching(/permission 'monitor' not granted/));
    expect(onLog).toHaveBeenCalledWith("sb", expect.stringMatching(/permission 'event' not granted/));
  });

  it("answers a connected session through a reply id: one line, capped, a few times, for a while", () => {
    const { host, bridge, sent, tick } = sandboxed(["event"]);
    bridge.receive({ type: "on", event: "on_connect" });
    const reply = vi.fn();
    host.dispatch("on_connect", { peerCall: "OE3ABC", reply });
    const replyId = last(sent, "event")!.replyId as number;
    expect(replyId).toBeGreaterThan(0);
    bridge.receive({ type: "reply", replyId, text: "Welcome\r\nOE3ABC " + "x".repeat(400) });
    expect(reply).toHaveBeenLastCalledWith(expect.stringMatching(/^Welcome OE3ABC x+$/));
    expect(reply.mock.lastCall![0]).toHaveLength(REPLY_TEXT_MAX);
    for (let i = 0; i < REPLY_MAX + 2; i++) bridge.receive({ type: "reply", replyId, text: "again" });
    expect(reply).toHaveBeenCalledTimes(REPLY_MAX);
    bridge.receive({ type: "reply", replyId: replyId + 99, text: "unknown id" });
    expect(reply).toHaveBeenCalledTimes(REPLY_MAX);
    host.dispatch("on_connect", { peerCall: "OE3ABC", reply });
    const later = last(sent, "event")!.replyId as number;
    tick(REPLY_TTL_MS + 1);
    bridge.receive({ type: "reply", replyId: later, text: "too late" });
    expect(reply).toHaveBeenCalledTimes(REPLY_MAX);
  });

  it("transmits only through the host's gate, rate limit and checks", async () => {
    let open = false;
    const transmit = vi.fn();
    const { bridge, sent } = sandboxed(["tx"], { txGate: () => open, transmit });
    bridge.receive({ type: "tx", id: 1, info: ">status" });
    await flush();
    expect(last(sent, "callResult")).toEqual({ type: "callResult", id: 1, result: false });
    open = true;
    bridge.receive({ type: "tx", id: 2, info: ">status" });
    bridge.receive({ type: "tx", id: 3, info: ">again at once" });
    bridge.receive({ type: "tx", id: 4, info: "}DL1X>APRS:>spoofed" });
    await flush();
    expect(sent.filter((m) => m.type === "callResult").map((m) => m.result)).toEqual([false, true, false, false]);
    expect(transmit).toHaveBeenCalledOnce();
    expect(transmit).toHaveBeenCalledWith("sb", ">status");
  });

  it("refuses transmit to a tool without 'tx', as an error its promise rejects with", async () => {
    const transmit = vi.fn();
    const { bridge, sent } = sandboxed(["command"], { txGate: () => true, transmit });
    bridge.receive({ type: "tx", id: 5, info: ">x" });
    await flush();
    expect(last(sent, "callResult")).toEqual({
      type: "callResult",
      id: 5,
      error: expect.stringMatching(/permission 'tx' not granted/),
    });
    expect(transmit).not.toHaveBeenCalled();
  });

  it("schedules, clamps and ends a beacon; switching the tool off ends it too", async () => {
    let open = false;
    const onBeacon = vi.fn();
    const { host, bridge, sent } = sandboxed(["beacon"], { txGate: () => open, onBeacon });
    bridge.receive({ type: "beacon", id: 1, spec: { comment: "QRV", intervalSec: 60 } });
    await flush();
    expect(last(sent, "callResult")).toEqual({ type: "callResult", id: 1, error: TX_CLOSED });
    open = true;
    bridge.receive({ type: "beacon", id: 2, spec: { comment: "QRV", intervalSec: 60 } });
    await flush();
    expect(last(sent, "callResult")).toEqual({ type: "callResult", id: 2, result: true });
    expect(onBeacon).toHaveBeenLastCalledWith("sb", { comment: "QRV", intervalSec: BEACON_MIN_INTERVAL_SEC });
    host.setEnabled("sb", false);
    expect(onBeacon).toHaveBeenLastCalledWith("sb", null);
    bridge.receive({ type: "beacon", id: 3, spec: { comment: "QRV", intervalSec: 900 } });
    await flush();
    expect(last(sent, "callResult")).toEqual({ type: "callResult", id: 3, error: "the tool is switched off" });
  });

  it("draws the map layer and the colour rules it was granted, sanitised", () => {
    const onChange = vi.fn();
    const host = new ToolHost();
    const sent: unknown[] = [];
    const bridge = new SandboxBridge((m) => sent.push(m), ["map", "monitor"], { onChange });
    host.register(
      sandboxTool(
        {
          name: "sb",
          title: "sb",
          author: "X",
          version: "1",
          permissions: ["map", "monitor"],
          surfaces: ["terminal", "map"],
        },
        bridge,
      ),
    );
    host.setEnabled("sb", true);
    bridge.receive({
      type: "map",
      spec: {
        id: "wp",
        points: [
          { lat: 47, lon: 15, label: "home" },
          { lat: 99, lon: 0 },
        ],
      },
    });
    expect(host.mapLayers()[0]!.spec.points).toEqual([
      { lat: 47, lon: 15, label: "home", glyph: undefined, tone: undefined },
    ]);
    bridge.receive({ type: "colours", rules: [{ src: "OE8APR", colorVar: "--warn" }] });
    expect(host.colourisers("terminal")[0]!({ src: "OE8APR", dst: "", text: "" })?.colorVar).toBe("--warn");
    expect(onChange).toHaveBeenCalled();
  });

  it("contributes no map layer or colours without their grants", () => {
    const { host, bridge } = sandboxed(["command"]);
    bridge.receive({ type: "map", spec: { id: "wp", points: [{ lat: 47, lon: 15 }] } });
    bridge.receive({ type: "colours", rules: [{ src: "OE8APR", colorVar: "--warn" }] });
    expect(host.mapLayers()).toEqual([]);
    expect(host.colourisers()).toEqual([]);
  });

  it("re-applies its panel, hooks and topics when switched on again", () => {
    const { host, bridge, sent } = sandboxed(["panel", "event", "ipc"]);
    bridge.receive({ type: "panel", spec: { title: "P", nodes: [{ kind: "text", text: "hi" }] } });
    bridge.receive({ type: "on", event: "on_tick" });
    bridge.receive({ type: "subscribe", topic: "station.seen" });
    host.setEnabled("sb", false);
    expect(host.panels("web")).toEqual([]);
    host.dispatch("on_tick");
    host.hostEmit("station.seen", { call: "A1A" });
    expect(sent.filter((m) => m.type === "event" || m.type === "ipcEvent")).toEqual([]);
    host.setEnabled("sb", true);
    expect(host.panels("web")[0]!.spec.title).toBe("P");
    host.dispatch("on_tick");
    host.hostEmit("station.seen", { call: "A1A" });
    expect(sent.filter((m) => m.type === "event" || m.type === "ipcEvent")).toHaveLength(2);
  });

  it("serves a service one sandboxed tool provides to another, under each tool's own name", async () => {
    const host = new ToolHost();
    const a = sandboxed(["ipc", "monitor"], {}, "station-db", host);
    const b = sandboxed(["ipc", "command"], {}, "info-responder", host);
    a.bridge.receive({ type: "provide", name: "station.type" });
    b.bridge.receive({ type: "call", id: 9, name: "station.type", args: "OE8XBM-1" });
    const call = last(a.sent, "svcCall")!;
    expect(call).toMatchObject({ name: "station.type", args: "OE8XBM-1" });
    a.bridge.receive({ type: "svcResult", id: call.id as number, result: "digi" });
    await flush();
    await flush();
    expect(last(b.sent, "callResult")).toEqual({ type: "callResult", id: 9, result: "digi" });
    b.bridge.receive({ type: "emit", topic: "render.blocks", data: { text: "X" } });
    a.bridge.receive({ type: "subscribe", topic: "render.blocks" });
    b.bridge.receive({ type: "emit", topic: "render.blocks", data: { text: "Y" } });
    expect(last(a.sent, "ipcEvent")).toEqual({
      type: "ipcEvent",
      topic: "render.blocks",
      data: { text: "Y" },
      from: "info-responder",
    });
  });

  it("refuses a service that requires 'tx' to a tool without it", async () => {
    const { host, bridge, sent } = sandboxed(["ipc"]);
    host.registerHostService("session.script", () => ({ ok: true }), { requires: "tx" });
    bridge.receive({ type: "call", id: 3, name: "session.script", args: { steps: [] } });
    await flush();
    expect(last(sent, "callResult")).toEqual({
      type: "callResult",
      id: 3,
      error: expect.stringMatching(/needs the 'tx' permission, which sb does not hold/),
    });
  });

  it("rejects the worker's call promise when the answer carries an error", () => {
    expect(frameSource("default-src 'none'")).toContain("p.rej(new Error(m.error))");
  });
});
