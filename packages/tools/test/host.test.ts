// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import {
  ToolHost,
  validateManifest,
  expand,
  withNow,
  parseBlocks,
  sanitizePanel,
  txInfoProblem,
  normalizeBeacon,
  TOOL_TX_MIN_GAP_MS,
  TOOL_TX_PER_HOUR,
  BEACON_MIN_INTERVAL_SEC,
  BEACON_MAX_INTERVAL_SEC,
  TX_INFO_MAX,
  TX_CLOSED,
  type Capability,
  type Tool,
  type ToolContext,
} from "../src/index.js";

describe("Tool manifest validation", () => {
  it("accepts a good manifest and normalises the callsign", () => {
    const r = validateManifest({
      name: "my-tool",
      title: "T",
      author: "oe8apr",
      version: "1.0",
      permissions: ["command"],
    });
    expect(r.ok && r.manifest.author).toBe("OE8APR");
  });
  it("rejects a bad name / unknown capability", () => {
    expect(validateManifest({ name: "Bad Name", title: "T", author: "X", version: "1", permissions: [] }).ok).toBe(
      false,
    );
    expect(validateManifest({ name: "ok", title: "T", author: "X", version: "1", permissions: ["hack"] }).ok).toBe(
      false,
    );
  });
  it("a network tool lists the https/wss origins it reaches, normalised to origins", () => {
    const base = { name: "net-tool", title: "T", author: "X", version: "1", permissions: ["network"] };
    expect(validateManifest(base).ok).toBe(false);
    expect(validateManifest({ ...base, connect: [] }).ok).toBe(false);
    const r = validateManifest({ ...base, connect: ["https://api.example.org/", "wss://feed.example.org:8443"] });
    expect(r.ok && r.manifest.connect).toEqual(["https://api.example.org", "wss://feed.example.org:8443"]);
  });
  it("refuses connect entries that are not bare https/wss origins", () => {
    const base = { name: "net-tool", title: "T", author: "X", version: "1", permissions: ["network"] };
    for (const bad of ["http://example.org", "https://example.org/path", "https://u:p@example.org", "*", 42])
      expect(validateManifest({ ...base, connect: [bad] }).ok).toBe(false);
    expect(validateManifest({ ...base, connect: Array.from({ length: 9 }, (_, i) => `https://h${i}.org`) }).ok).toBe(
      false,
    );
  });
});

/** A test tool: a manifest with the given permissions and surfaces, and its activation. */
function mk(
  name: string,
  permissions: Capability[],
  activate: Tool["activate"],
  extra: Partial<Tool["manifest"]> = {},
): Tool {
  return {
    manifest: { name, title: name, author: "X", version: "1", permissions, surfaces: ["web"], ...extra },
    activate,
  };
}

describe("ToolHost — capability enforcement + dispatch", () => {
  it("tools register off, and contribute commands, colourisers and decoders once enabled", () => {
    const host = new ToolHost();
    host.register(
      mk("kit", ["command", "monitor", "decoder"], (ctx) => {
        ctx.registerCommand("cq", () => ["CQ CQ CQ de {call} k"]);
        ctx.addColouriser((l) => (l.src.startsWith("OE") ? { colorVar: "--st-user" } : null));
        ctx.addDecoder({ id: "up", label: "Upper", kind: "text", decode: (s) => s.toUpperCase() });
      }),
    );
    expect(host.list().every((t) => !t.enabled)).toBe(true); // OFF until switched on
    expect(host.runCommand("cq")).toBeNull();
    host.setEnabled("kit", true);
    expect(host.runCommand("cq")).toEqual(["CQ CQ CQ de {call} k"]);
    expect(host.colourisers()[0]!({ src: "OE8APR-9", dst: "APRS", text: "" })!.colorVar).toBe("--st-user");
    expect(host.decoders()[0]!.decode("abc")).toBe("ABC");
  });

  it("a tool cannot use a surface it wasn't granted (capability gate)", () => {
    const host = new ToolHost();
    host.register(mk("rogue", ["monitor"], (ctx) => ctx.registerCommand("hack", () => ["pwned"])));
    const r = host.setEnabled("rogue", true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission 'command' not granted/);
    expect(host.runCommand("hack")).toBeNull(); // nothing registered
  });

  it("dispatches events; a handler answers a connected session through the payload's reply", () => {
    const host = new ToolHost();
    host.register(
      mk("greeter", ["event"], (ctx) => ctx.on("on_connect", (p) => p.reply?.(`Welcome ${p.peerCall ?? ""}`))),
    );
    host.setEnabled("greeter", true);
    const reply = vi.fn();
    host.dispatch("on_connect", { peerCall: "OE3ABC", reply });
    expect(reply).toHaveBeenCalledWith("Welcome OE3ABC");
  });

  it("on_frame needs 'monitor', every other event 'event'", () => {
    const host = new ToolHost();
    host.register(mk("frames", ["event"], (ctx) => ctx.on("on_frame", () => undefined)));
    expect(host.setEnabled("frames", true).error).toMatch(/permission 'monitor' not granted/);
  });

  it("disabling a tool removes its contributions", () => {
    const host = new ToolHost();
    host.register(mk("m", ["command"], (ctx) => ctx.registerCommand("73", () => ["73"])));
    host.setEnabled("m", true);
    expect(host.runCommand("73")).not.toBeNull();
    host.setEnabled("m", false);
    expect(host.runCommand("73")).toBeNull();
  });
});

describe("Transmit and beacons — gated, checked and rate-limited by the host", () => {
  const txTool = (onCtx: (ctx: ToolContext) => void) => mk("tx-tool", ["command", "tx", "beacon"], onCtx);

  it("requestTx is refused while the gate is closed and transmits once it opens", async () => {
    let open = false;
    const transmit = vi.fn(() => true);
    let ctx!: ToolContext;
    const host = new ToolHost({ txGate: () => open, transmit });
    host.register(txTool((c) => (ctx = c)));
    host.setEnabled("tx-tool", true);
    expect(await ctx.requestTx(">on the air")).toBe(false);
    expect(transmit).not.toHaveBeenCalled();
    open = true;
    expect(await ctx.requestTx(">on the air")).toBe(true);
    expect(transmit).toHaveBeenCalledWith("tx-tool", ">on the air");
  });

  it("reports the radio's real outcome", async () => {
    let ctx!: ToolContext;
    const host = new ToolHost({ txGate: () => true, transmit: () => Promise.resolve(false) });
    host.register(txTool((c) => (ctx = c)));
    host.setEnabled("tx-tool", true);
    expect(await ctx.requestTx(">held by the radio")).toBe(false);
  });

  it("one transmission per TOOL_TX_MIN_GAP_MS, and TOOL_TX_PER_HOUR sustained, for each tool", async () => {
    let now = 1_000_000;
    const transmit = vi.fn();
    const onLog = vi.fn();
    let ctx!: ToolContext;
    const host = new ToolHost({ txGate: () => true, transmit, onLog, now: () => now });
    host.register(txTool((c) => (ctx = c)));
    host.setEnabled("tx-tool", true);
    expect(await ctx.requestTx(">one")).toBe(true);
    now += TOOL_TX_MIN_GAP_MS - 1;
    expect(await ctx.requestTx(">two")).toBe(false);
    expect(onLog).toHaveBeenCalledWith("tx-tool", expect.stringMatching(/transmit held: one transmission per/));
    now += 1;
    expect(await ctx.requestTx(">three")).toBe(true);
    for (let i = 0; i < TOOL_TX_PER_HOUR; i++) {
      now += TOOL_TX_MIN_GAP_MS;
      await ctx.requestTx(">more");
    }
    expect(transmit).toHaveBeenCalledTimes(TOOL_TX_PER_HOUR); // the bucket is spent within the hour
    expect(onLog).toHaveBeenLastCalledWith("tx-tool", expect.stringMatching(/at most 6 transmissions an hour/));
    now += 10 * 60_000; // one token refills every ten minutes
    expect(await ctx.requestTx(">later")).toBe(true);
    // the budget belongs to the tool's name: switching it off and on again does not refill it
    host.setEnabled("tx-tool", false);
    host.setEnabled("tx-tool", true);
    now += TOOL_TX_MIN_GAP_MS;
    expect(await ctx.requestTx(">again")).toBe(false);
  });

  it("transmits only an APRS status or message", async () => {
    const transmit = vi.fn();
    let ctx!: ToolContext;
    let now = 0;
    const host = new ToolHost({ txGate: () => true, transmit, now: () => (now += 3_600_000) });
    host.register(txTool((c) => (ctx = c)));
    host.setEnabled("tx-tool", true);
    for (const bad of [
      "",
      "  ",
      ">a\r\nb",
      ">" + "x".repeat(63),
      "x".repeat(TX_INFO_MAX + 1),
      "}OE1XYZ>APRS:>spoof",
      "!4704.41N/01526.27E>position",
      ";OBJECT   *111111z4704.41N/01526.27E>",
      ")ITEM!4704.41N/01526.27E>",
      "T#001,1,2,3,4,5,00000000",
      ":         :no addressee",
      ":OE1XYZ   :pipe | inside",
      42 as never,
    ])
      expect(await ctx.requestTx(bad)).toBe(false);
    expect(transmit).not.toHaveBeenCalled();
    for (const good of [">QRV on 2m", ":OE1XYZ   :hello there{12", ":OE1XYZ   :ack12"])
      expect(txInfoProblem(good)).toBeNull();
    expect(await ctx.requestTx(":OE1XYZ   :ack12")).toBe(true);
  });

  it("requestTx and scheduleBeacon need their own permissions", () => {
    const host = new ToolHost({ txGate: () => true });
    host.register(mk("notx", ["command"], (ctx) => void ctx.requestTx(">x")));
    expect(host.setEnabled("notx", true).error).toMatch(/permission 'tx' not granted/);
    host.register(mk("nobeacon", ["tx"], (ctx) => ctx.scheduleBeacon({ comment: "x", intervalSec: 600 })));
    expect(host.setEnabled("nobeacon", true).error).toMatch(/permission 'beacon' not granted/);
  });

  it("scheduleBeacon throws while the gate is closed, clamps the interval, and ends with null or switch-off", () => {
    let open = false;
    const onBeacon = vi.fn();
    let ctx!: ToolContext;
    const host = new ToolHost({ txGate: () => open, onBeacon });
    host.register(txTool((c) => (ctx = c)));
    host.setEnabled("tx-tool", true);
    expect(() => ctx.scheduleBeacon({ comment: "test", intervalSec: 1800 })).toThrow(TX_CLOSED);
    expect(onBeacon).not.toHaveBeenCalled();
    open = true;
    ctx.scheduleBeacon({ comment: "test", intervalSec: 60 });
    expect(onBeacon).toHaveBeenLastCalledWith("tx-tool", { comment: "test", intervalSec: BEACON_MIN_INTERVAL_SEC });
    ctx.scheduleBeacon(null);
    expect(onBeacon).toHaveBeenLastCalledWith("tx-tool", null);
    ctx.scheduleBeacon({ comment: "again", intervalSec: 1800 });
    host.setEnabled("tx-tool", false);
    expect(onBeacon).toHaveBeenLastCalledWith("tx-tool", null);
    expect(onBeacon).toHaveBeenCalledTimes(4);
  });

  it("normalizeBeacon keeps one short line and refuses what cannot beacon", () => {
    expect(normalizeBeacon({ comment: "a\nb", intervalSec: 99_999_999 })).toEqual({
      comment: "a b",
      intervalSec: BEACON_MAX_INTERVAL_SEC,
    });
    const long = normalizeBeacon({ comment: "x".repeat(80), intervalSec: 900 }) as { comment: string };
    expect(long).toMatchObject({ intervalSec: 900 });
    expect(long.comment).toHaveLength(62);
    for (const bad of [null, {}, { comment: "" }, { comment: "x" }, { comment: "}spoof", intervalSec: 900 }])
      expect(typeof normalizeBeacon(bad)).toBe("string");
  });
});

describe("The host ends a beacon and guards its own services", () => {
  it("endBeacon ends a tool's beacon from the host's side and logs why", () => {
    const onBeacon = vi.fn();
    const onLog = vi.fn();
    let ctx!: ToolContext;
    const host = new ToolHost({ txGate: () => true, onBeacon, onLog });
    host.register(mk("b", ["beacon"], (c) => (ctx = c)));
    host.setEnabled("b", true);
    ctx.scheduleBeacon({ comment: "QRV", intervalSec: 900 });
    expect(host.beaconTools()).toEqual(["b"]);
    host.endBeacon("b", "the transmit consent ended");
    expect(onBeacon).toHaveBeenLastCalledWith("b", null);
    expect(onLog).toHaveBeenCalledWith("b", "beacon ended: the transmit consent ended");
    expect(host.beaconTools()).toEqual([]);
    host.setEnabled("b", false); // nothing left to end: no second null
    expect(onBeacon).toHaveBeenCalledTimes(2);
  });

  it("a tool cannot take over a service another provider holds, nor a reserved name", () => {
    const host = new ToolHost();
    host.registerHostService("session.script", () => ({ ok: true }), { requires: "tx" });
    host.register(mk("owner", ["ipc"], (ctx) => ctx.provideService("station.type", () => "digi")));
    host.register(mk("thief", ["ipc"], (ctx) => ctx.provideService("station.type", () => "spoofed")));
    host.register(mk("hijack", ["ipc"], (ctx) => ctx.provideService("session.script", () => ({ ok: true }))));
    host.register(mk("hostname", ["ipc"], (ctx) => ctx.provideService("host.anything", () => 1)));
    host.register(mk("fake", ["ipc"], (ctx) => ctx.emit("session.progress", { status: "done" })));
    expect(host.setEnabled("owner", true).ok).toBe(true);
    expect(host.setEnabled("thief", true).error).toMatch(/"station.type" is already provided by owner/);
    expect(host.setEnabled("hijack", true).error).toMatch(/"session.script" is reserved for the app/);
    expect(host.setEnabled("hostname", true).error).toMatch(/"host.anything" is reserved/);
    expect(host.setEnabled("fake", true).error).toMatch(/topic "session.progress" is reserved/);
    expect(() => host.toolBus("x", ["ipc"]).emit("session.progress", {})).toThrow(/reserved/);
    expect(host.toolBus("caller", ["ipc"]).call("station.type")).toBe("digi");
    expect(host.toolBus("caller", ["ipc", "tx"]).call("session.script", {})).toEqual({ ok: true });
    // the provider may replace its own service, and once it is off the name is free again
    host.setEnabled("owner", false);
    expect(host.setEnabled("thief", true).ok).toBe(true);
  });

  it("a host service learns which tool calls it", () => {
    const host = new ToolHost();
    const callers: string[] = [];
    host.registerHostService("session.script", (_a, caller) => callers.push(caller));
    host.toolBus("sched-query", ["ipc"]).call("session.script", {});
    host.register(mk("inproc", ["ipc"], (ctx) => void ctx.callService("session.script", {})));
    host.setEnabled("inproc", true);
    expect(callers).toEqual(["sched-query", "inproc"]);
  });
});

describe("Tool surfaces — a tool's type routes its contributions", () => {
  it("defaults surfaces to ['web'] and validates the enum", () => {
    const r = validateManifest({ name: "tt", title: "T", author: "X", version: "1", permissions: ["panel"] });
    expect(r.ok && r.manifest.surfaces).toEqual(["web"]);
    const t2 = validateManifest({
      name: "tt",
      title: "T",
      author: "X",
      version: "1",
      permissions: ["command"],
      surfaces: ["terminal", "bbs"],
    });
    expect(t2.ok && t2.manifest.surfaces).toEqual(["terminal", "bbs"]);
    expect(
      validateManifest({ name: "tt", title: "T", author: "X", version: "1", permissions: [], surfaces: ["nope"] }).ok,
    ).toBe(false);
  });

  it("filters commands/colourisers by the requesting surface", () => {
    const host = new ToolHost();
    host.register(
      mk("macros", ["command"], (ctx) => ctx.registerCommand("cq", () => ["cq"]), { surfaces: ["terminal", "bbs"] }),
    );
    host.register(mk("colour", ["monitor"], (ctx) => ctx.addColouriser(() => null), { surfaces: ["terminal"] }));
    host.setEnabled("macros", true);
    host.setEnabled("colour", true);
    expect(host.runCommand("cq", "", "terminal")).not.toBeNull();
    expect(host.runCommand("cq", "", "bbs")).not.toBeNull();
    expect(host.runCommand("cq", "", "node")).toBeNull();
    expect(host.colourisers("terminal")).toHaveLength(1);
    expect(host.colourisers("bbs")).toHaveLength(0);
    expect(host.commandNames("web")).toEqual([]);
  });

  it("unregister switches a tool off, drops its contributions and frees its name", () => {
    const host = new ToolHost();
    const make = () => mk("m", ["command"], (ctx) => ctx.registerCommand("cq", () => ["cq"]));
    host.register(make());
    host.setEnabled("m", true);
    expect(host.runCommand("cq")).not.toBeNull();
    expect(host.unregister("m")).toBe(true);
    expect(host.runCommand("cq")).toBeNull();
    expect(host.list()).toHaveLength(0);
    expect(host.unregister("m")).toBe(false);
    host.register(make()); // the name is free again
    expect(host.list()).toHaveLength(1);
  });

  it("on_tick dispatches to tools hooking it", () => {
    const ticks: number[] = [];
    const host = new ToolHost();
    host.register(mk("ticker", ["event"], (ctx) => ctx.on("on_tick", () => ticks.push(1))));
    host.setEnabled("ticker", true);
    host.dispatch("on_tick");
    host.dispatch("on_tick");
    expect(ticks).toHaveLength(2);
  });

  it("remote peers only reach remote-allowed tools, and only their remote commands", () => {
    const host = new ToolHost();
    host.register(mk("local", ["command"], (ctx) => ctx.registerCommand("cq", () => ["cq"]), { surfaces: ["bbs"] }));
    host.register(
      mk(
        "rq",
        ["command"],
        (ctx) => {
          ctx.registerCommand("info", () => ["ok"]);
          ctx.registerCommand("setinfo", () => ["set"], { remote: false });
        },
        { surfaces: ["bbs"], remote: true },
      ),
    );
    host.setEnabled("rq", true);
    host.setEnabled("local", true);
    expect(host.runCommand("info", "", "bbs", { remote: true })).toEqual(["ok"]);
    expect(host.runCommand("setinfo", "", "bbs", { remote: true })).toBeNull(); // operator-only command
    expect(host.runCommand("setinfo", "", "bbs")).toEqual(["set"]);
    expect(host.runCommand("cq", "", "bbs", { remote: true })).toBeNull(); // tool not remote-allowed
    expect(host.runCommand("cq", "", "bbs")).not.toBeNull();
  });

  it("the shared store persists across command invocations", () => {
    const host = new ToolHost();
    host.register(
      mk("counter", ["command"], (ctx) =>
        ctx.registerCommand("bump", () => {
          const n = Number(ctx.store.get("n") ?? "0") + 1;
          ctx.store.set("n", String(n));
          return [String(n)];
        }),
      ),
    );
    host.setEnabled("counter", true);
    expect(host.runCommand("bump")![0]).toBe("1");
    expect(host.runCommand("bump")![0]).toBe("2");
  });

  it("map capability: setMapLayer is gated, and mapLayers() returns layers from map-surface tools", () => {
    const host = new ToolHost();
    host.register(
      mk(
        "pins",
        ["command", "map"],
        (ctx) =>
          ctx.registerCommand("wp", (a) => {
            ctx.setMapLayer({ id: "wp", points: a ? [{ lat: 47, lon: 15, label: a }] : [] });
            return ["ok"];
          }),
        { surfaces: ["web", "map"] },
      ),
    );
    host.setEnabled("pins", true);
    expect(host.mapLayers()).toHaveLength(0);
    host.runCommand("wp", "home");
    expect(host.mapLayers()[0]!.spec.points[0]!.label).toBe("home");
    host.register(
      mk("rogue-map", ["command"], (ctx) => ctx.setMapLayer({ id: "x", points: [] }), { surfaces: ["map"] }),
    );
    expect(host.setEnabled("rogue-map", true).error).toMatch(/permission 'map' not granted/);
  });

  it("onChange fires whenever a tool replaces its panel or map layer, so a UI re-reads without polling", () => {
    const onChange = vi.fn();
    const host = new ToolHost({ onChange });
    host.register(
      mk("p", ["monitor", "panel"], (ctx) =>
        ctx.on("on_frame", (f) => ctx.setPanel({ nodes: [{ kind: "text", text: String(f.peerCall) }] })),
      ),
    );
    host.setEnabled("p", true);
    onChange.mockClear();
    host.dispatch("on_frame", { peerCall: "OE8XBM-7", source: "RF" });
    expect(onChange).toHaveBeenCalled();
  });

  it("panel capability: setPanel is gated, and panels() returns the spec for the surface", () => {
    const host = new ToolHost();
    host.register(
      mk("guide", ["panel"], (ctx) => ctx.setPanel({ title: "SSIDs", nodes: [] }), {
        surfaces: ["web", "terminal", "bbs"],
      }),
    );
    host.setEnabled("guide", true);
    expect(host.panels("web")[0]!.spec.title).toBe("SSIDs");
    expect(host.panels("node")).toHaveLength(0);
    host.register(mk("rogue-panel", ["command"], (ctx) => ctx.setPanel({ nodes: [] })));
    expect(host.setEnabled("rogue-panel", true).error).toMatch(/permission 'panel' not granted/);
  });
});

describe("Inter-tool IPC bus — the host routes, never interprets", () => {
  const producer = (): Tool => ({
    manifest: {
      name: "prod",
      title: "P",
      author: "X",
      version: "1",
      permissions: ["ipc", "command"],
      surfaces: ["web"],
    },
    activate(ctx) {
      ctx.provideService("sum", (a) => {
        const { x, y } = a as { x: number; y: number };
        return x + y;
      });
      ctx.registerCommand("fire", (args) => {
        ctx.emit("topic.a", { msg: args });
        return ["fired"];
      });
    },
  });
  const consumer = (sink: string[]): Tool => ({
    manifest: { name: "cons", title: "C", author: "X", version: "1", permissions: ["ipc"], surfaces: ["web"] },
    activate(ctx) {
      ctx.subscribe("topic.a", (data, from) => sink.push(`${from}:${(data as { msg: string }).msg}`));
    },
  });

  it("emit → subscribe delivers the opaque payload + emitting tool name", () => {
    const sink: string[] = [];
    const host = new ToolHost();
    host.register(producer());
    host.register(consumer(sink));
    host.setEnabled("prod", true);
    host.setEnabled("cons", true);
    host.runCommand("fire", "hi");
    expect(sink).toEqual(["prod:hi"]);
  });

  it("provideService / callService is a request/response between tools", () => {
    const host = new ToolHost();
    const caller: Tool = {
      manifest: {
        name: "caller",
        title: "C",
        author: "X",
        version: "1",
        permissions: ["ipc", "command"],
        surfaces: ["web"],
      },
      activate(ctx) {
        ctx.registerCommand("ask", () => [String(ctx.callService("sum", { x: 2, y: 3 }))]);
      },
    };
    host.register(producer());
    host.register(caller);
    host.setEnabled("prod", true);
    host.setEnabled("caller", true);
    expect(host.runCommand("ask")).toEqual(["5"]);
    expect(host.ipcServices()).toContain("sum");
  });

  it("disabling a tool tears down its subscriptions + services", () => {
    const sink: string[] = [];
    const host = new ToolHost();
    host.register(producer());
    host.register(consumer(sink));
    host.setEnabled("prod", true);
    host.setEnabled("cons", true);
    host.setEnabled("cons", false); // subscriber gone
    host.runCommand("fire", "x");
    expect(sink).toEqual([]); // not delivered
    host.setEnabled("prod", false); // provider gone
    const c: Tool = {
      manifest: {
        name: "c2",
        title: "C",
        author: "X",
        version: "1",
        permissions: ["ipc", "command"],
        surfaces: ["web"],
      },
      activate(ctx) {
        ctx.registerCommand("q", () => [String(ctx.callService("sum", { x: 1, y: 1 }))]);
      },
    };
    host.register(c);
    host.setEnabled("c2", true);
    expect(host.runCommand("q")).toEqual(["undefined"]); // service no longer provided
    expect(host.ipcServices()).not.toContain("sum");
  });

  it("emit/subscribe require the 'ipc' capability", () => {
    const rogue: Tool = {
      manifest: { name: "noipc", title: "N", author: "X", version: "1", permissions: ["command"], surfaces: ["web"] },
      activate(ctx) {
        (ctx as unknown as { emit: (t: string) => void }).emit("x");
      },
    };
    const host = new ToolHost();
    host.register(rogue);
    expect(host.setEnabled("noipc", true).error).toMatch(/permission 'ipc' not granted/);
  });

  it("a surface (host) can provide a service to tools + publish to them; disposers clean up", () => {
    const host = new ToolHost();
    const seen: unknown[] = [];
    const consumer: Tool = {
      manifest: {
        name: "cons2",
        title: "C",
        author: "X",
        version: "1",
        permissions: ["ipc", "command"],
        surfaces: ["terminal"],
      },
      activate(ctx) {
        ctx.subscribe("session.progress", (d) => seen.push(d));
        ctx.registerCommand("go", () => [String(ctx.callService("session.script", { steps: [1, 2] }))]);
      },
    };
    host.register(consumer);
    host.setEnabled("cons2", true);
    const dispose = host.registerHostService("session.script", (a) => (a as { steps: unknown[] }).steps.length);
    expect(host.runCommand("go", "", "terminal")).toEqual(["2"]); // tool reached the host service
    host.hostEmit("session.progress", { status: "running" });
    expect(seen).toEqual([{ status: "running" }]);
    dispose();
    expect(host.runCommand("go", "", "terminal")).toEqual(["undefined"]); // service gone after dispose
  });
});

describe("The bus for a sandboxed tool — its own sender name, its own grants", () => {
  const listener = (sink: string[]): Tool => ({
    manifest: { name: "listen", title: "L", author: "X", version: "1", permissions: ["ipc"], surfaces: ["web"] },
    activate(ctx) {
      ctx.subscribe("topic.a", (data, from) => sink.push(`${from}:${String(data)}`));
      ctx.provideService("whoami", () => "listen");
    },
  });

  it("emit from a sandboxed tool carries the tool's manifest name, not (host)", () => {
    const sink: string[] = [];
    const host = new ToolHost();
    host.register(listener(sink));
    host.setEnabled("listen", true);
    host.toolBus("imported-x", ["ipc"]).emit("topic.a", "hi");
    expect(sink).toEqual(["imported-x:hi"]);
  });

  it("subscribers of a sandboxed tool see each sender's own name", () => {
    const host = new ToolHost();
    const seen: string[] = [];
    const off = host.toolBus("imported-x", ["ipc"]).subscribe("topic.b", (data, from) => seen.push(`${from}:${data}`));
    host.toolBus("imported-y", ["ipc"]).emit("topic.b", 1);
    host.hostEmit("topic.b", 2);
    off();
    host.hostEmit("topic.b", 3);
    expect(seen).toEqual(["imported-y:1", "(host):2"]);
  });

  it("an in-process tool and the app keep their own sender names", () => {
    const sink: string[] = [];
    const host = new ToolHost();
    const inProcess: Tool = {
      manifest: {
        name: "emitter",
        title: "E",
        author: "X",
        version: "1",
        permissions: ["ipc", "command"],
        surfaces: ["web"],
      },
      activate(ctx) {
        ctx.registerCommand("go", () => {
          ctx.emit("topic.a", "b");
          return [];
        });
      },
    };
    host.register(listener(sink));
    host.register(inProcess);
    host.setEnabled("listen", true);
    host.setEnabled("emitter", true);
    host.runCommand("go");
    host.hostEmit("topic.a", "h");
    expect(sink).toEqual(["emitter:b", "(host):h"]);
  });

  it("a sandboxed tool calls a service that requires nothing with ipc alone", () => {
    const host = new ToolHost();
    host.register(listener([]));
    host.setEnabled("listen", true);
    expect(host.toolBus("imported-x", ["ipc"]).call("whoami")).toBe("listen");
  });

  it("session.script is refused to a sandboxed tool without 'tx' and served with it", () => {
    const host = new ToolHost();
    const got: unknown[] = [];
    host.registerHostService(
      "session.script",
      (a) => {
        got.push(a);
        return { ok: true };
      },
      { requires: "tx" },
    );
    expect(() => host.toolBus("imported-x", ["ipc"]).call("session.script", { steps: [] })).toThrow(
      /service "session.script" needs the 'tx' permission, which imported-x does not hold/,
    );
    expect(got).toEqual([]);
    expect(host.toolBus("imported-x", ["ipc", "tx"]).call("session.script", { steps: [] })).toEqual({ ok: true });
    expect(got).toHaveLength(1);
  });

  it("session.script is refused to an in-process tool without 'tx' and served with it", () => {
    const host = new ToolHost();
    host.registerHostService("session.script", () => ({ ok: true }), { requires: "tx" });
    const caller = (name: string, permissions: Tool["manifest"]["permissions"]): Tool => ({
      manifest: { name, title: "C", author: "X", version: "1", permissions, surfaces: ["terminal"] },
      activate(ctx) {
        ctx.registerCommand(name, () => [JSON.stringify(ctx.callService("session.script", { steps: [] }))]);
      },
    });
    host.register(caller("notx", ["ipc", "command"]));
    host.register(caller("withtx", ["ipc", "command", "tx"]));
    host.setEnabled("notx", true);
    host.setEnabled("withtx", true);
    expect(host.runCommand("notx")![0]).toMatch(/error: service "session.script" needs the 'tx' permission/);
    expect(host.runCommand("withtx")).toEqual(['{"ok":true}']);
  });
});

describe("(GP GIP) blocks panel node", () => {
  it("parseBlocks pads ragged lines to a rectangular grid; cols = widest line", () => {
    const b = parseBlocks("ABC\nD");
    expect(b.kind).toBe("blocks");
    expect(b.cols).toBe(3);
    expect(b.cells.map((c) => c.ch).join("")).toBe("ABCD  "); // second row padded to 3
  });
  it("sanitizePanel bounds a blocks node (cols clamp, single-char cells, ANSI colour 0–15)", () => {
    const s = sanitizePanel({
      nodes: [
        {
          kind: "blocks",
          cols: 999,
          cells: [
            { ch: "XY", c: 3 },
            { ch: "!", c: 99 },
          ],
        },
      ],
    });
    const b = s.nodes[0] as { kind: string; cols: number; cells: { ch: string; c?: number }[] };
    expect(b.kind).toBe("blocks");
    expect(b.cols).toBe(200); // clamped
    expect(b.cells[0]).toEqual({ ch: "X", c: 3 }); // truncated to 1 char, colour kept
    expect(b.cells[1]).toEqual({ ch: "!" }); // out-of-range colour dropped
  });
});

describe("(C) macro variable expansion", () => {
  it("substitutes known {tokens} and leaves unknown ones intact", () => {
    expect(expand("CQ de {call} k", { call: "OE8APR" })).toBe("CQ de OE8APR k");
    expect(expand("QTH {grid}, hi {peer}", { grid: "JN76", peer: "OE3ABC" })).toBe("QTH JN76, hi OE3ABC");
    expect(expand("unknown {nope} stays", {})).toBe("unknown {nope} stays");
  });
  it("leaves a token naming an inherited property literal", () => {
    for (const t of ["{constructor}", "{toString}", "{__proto__}", "{hasOwnProperty}", "{valueOf}"])
      expect(expand(`x ${t} y`, { call: "OE8APR" })).toBe(`x ${t} y`);
    expect(expand("{constructor}", { constructor: "own" } as never)).toBe("own");
  });
  it("withNow fills date/time but never clobbers explicit vars", () => {
    const v = withNow({ call: "OE8APR", date: "2020-01-01" }, new Date(Date.UTC(2026, 6, 2, 9, 5)));
    expect(v.date).toBe("2020-01-01"); // explicit wins
    expect(v.time).toBe("09:05Z");
    expect(v.call).toBe("OE8APR");
  });
});
