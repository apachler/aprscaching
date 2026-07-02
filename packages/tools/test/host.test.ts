import { describe, it, expect, vi } from "vitest";
import { ToolHost, validateManifest, builtinTools, expand, withNow, type Tool } from "../src/index.js";

describe("Tool manifest validation", () => {
  it("accepts a good manifest and normalises the callsign", () => {
    const r = validateManifest({ name: "my-tool", title: "T", author: "oe8apr", version: "1.0", permissions: ["command"] });
    expect(r.ok && r.manifest.author).toBe("OE8APR");
  });
  it("rejects a bad name / unknown capability", () => {
    expect(validateManifest({ name: "Bad Name", title: "T", author: "X", version: "1", permissions: [] }).ok).toBe(false);
    expect(validateManifest({ name: "ok", title: "T", author: "X", version: "1", permissions: ["hack"] }).ok).toBe(false);
  });
});

describe("ToolHost — capability enforcement + dispatch (docs/27 B.3)", () => {
  it("built-in tools register, enable, and contribute commands/colourisers/decoders", () => {
    const host = new ToolHost();
    for (const t of builtinTools()) host.register(t);
    expect(host.list()).toHaveLength(18);
    expect(host.list().every((t) => !t.enabled)).toBe(true);          // OFF by default
    host.setEnabled("ctext-macros", true);
    expect(host.runCommand("cq")).toEqual(["CQ CQ CQ de {call} k"]);
    host.setEnabled("monitor-colouriser", true);
    expect(host.colourisers()[0]!({ src: "OE8APR-9", dst: "APRS", text: "!4704.41N/01526.27E>" })!.colorVar).toBe("--st-beacon");
    host.setEnabled("digimode-decoders", true);
    expect(host.decoders().map((d) => d.id).sort()).toEqual(["cw", "psk31"]);
  });

  it("a tool cannot use a surface it wasn't granted (capability gate)", () => {
    const rogue: Tool = {
      manifest: { name: "rogue", title: "Rogue", author: "X", version: "1", permissions: ["monitor"], surfaces: ["web"] },
      activate(ctx) { ctx.registerCommand("hack", () => ["pwned"]); }, // needs 'command' — not granted
    };
    const host = new ToolHost();
    host.register(rogue);
    const r = host.setEnabled("rogue", true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission 'command' not granted/);
    expect(host.runCommand("hack")).toBeNull();                       // nothing registered
  });

  it("TX/beacon is gated: scheduleBeacon fails when the TX gate is closed, works when open", () => {
    const onBeacon = vi.fn();
    let txOpen = false;
    const host = new ToolHost({ txGate: () => txOpen, onBeacon });
    host.register(builtinTools().find((t) => t.manifest.name === "beacon-scheduler")!);
    host.setEnabled("beacon-scheduler", true);
    expect(host.runCommand("beacon", "30 test")![0]).toMatch(/error:.*TX gate closed/);
    expect(onBeacon).not.toHaveBeenCalled();
    txOpen = true;
    expect(host.runCommand("beacon", "30 test")![0]).toMatch(/scheduled/);
    expect(onBeacon).toHaveBeenCalledOnce();
  });

  it("dispatches events; the auto-responder greets an incoming connect via the payload reply", () => {
    const host = new ToolHost();
    host.register(builtinTools().find((t) => t.manifest.name === "auto-responder")!);
    host.setEnabled("auto-responder", true);
    const reply = vi.fn();
    host.dispatch("on_connect", { reply });
    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/auto-responder/));
  });

  it("disabling a tool removes its contributions", () => {
    const host = new ToolHost();
    for (const t of builtinTools()) host.register(t);
    host.setEnabled("ctext-macros", true);
    expect(host.runCommand("73")).not.toBeNull();
    host.setEnabled("ctext-macros", false);
    expect(host.runCommand("73")).toBeNull();
  });
});

describe("Tool surfaces — a tool's type routes its contributions (docs/28)", () => {
  it("defaults surfaces to ['web'] and validates the enum", () => {
    const r = validateManifest({ name: "tt", title: "T", author: "X", version: "1", permissions: ["panel"] });
    expect(r.ok && r.manifest.surfaces).toEqual(["web"]);
    const t2 = validateManifest({ name: "tt", title: "T", author: "X", version: "1", permissions: ["command"], surfaces: ["terminal", "bbs"] });
    expect(t2.ok && t2.manifest.surfaces).toEqual(["terminal", "bbs"]);
    expect(validateManifest({ name: "tt", title: "T", author: "X", version: "1", permissions: [], surfaces: ["nope"] }).ok).toBe(false);
  });

  it("filters commands/colourisers by the requesting surface", () => {
    const host = new ToolHost();
    for (const t of builtinTools()) host.register(t);
    host.setEnabled("ctext-macros", true);          // surfaces: terminal, bbs
    host.setEnabled("monitor-colouriser", true);    // surfaces: terminal
    expect(host.runCommand("cq", "", "terminal")).not.toBeNull();
    expect(host.runCommand("cq", "", "bbs")).not.toBeNull();
    expect(host.runCommand("cq", "", "node")).toBeNull();       // ctext-macros doesn't target node
    expect(host.colourisers("terminal")).toHaveLength(1);
    expect(host.colourisers("bbs")).toHaveLength(0);            // colouriser is terminal-only
    expect(host.commandNames("web")).toEqual([]);              // no command tool targets web
  });

  it("(A) events carry channel/peer context — the auto-responder greets the peer by callsign", () => {
    const host = new ToolHost();
    host.register(builtinTools().find((t) => t.manifest.name === "auto-responder")!);
    host.setEnabled("auto-responder", true);
    const reply = vi.fn();
    host.dispatch("on_connect", { surface: "bbs", peerCall: "OE3ABC", myCall: "OE8APR-1", reply });
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("OE3ABC"));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("OE8APR-1"));
  });

  it("(B) on_tick dispatches to tools hooking it", () => {
    const ticks: number[] = [];
    const t: Tool = {
      manifest: { name: "ticker", title: "T", author: "X", version: "1", permissions: ["event"], surfaces: ["web"] },
      activate(ctx) { ctx.on("on_tick", () => ticks.push(1)); },
    };
    const host = new ToolHost();
    host.register(t); host.setEnabled("ticker", true);
    host.dispatch("on_tick"); host.dispatch("on_tick");
    expect(ticks).toHaveLength(2);
  });

  it("(D) remote peers only reach remote-allowed command tools", () => {
    const host = new ToolHost();
    host.register(builtinTools().find((t) => t.manifest.name === "ctext-macros")!); // remote:false, surfaces terminal/bbs
    const rq: Tool = {
      manifest: { name: "rq", title: "Remote query", author: "X", version: "1", permissions: ["command"], surfaces: ["bbs"], remote: true },
      activate(ctx) { ctx.registerCommand("info", () => ["ok"]); },
    };
    host.register(rq); host.setEnabled("rq", true); host.setEnabled("ctext-macros", true);
    expect(host.runCommand("info", "", "bbs", { remote: true })).not.toBeNull();   // remote tool answers a peer
    expect(host.runCommand("cq", "", "bbs", { remote: true })).toBeNull();         // macro is operator-only
    expect(host.runCommand("cq", "", "bbs")).not.toBeNull();                        // …but local still works
  });

  it("(E) the shared store persists across command invocations", () => {
    const host = new ToolHost();
    const t: Tool = {
      manifest: { name: "counter", title: "C", author: "X", version: "1", permissions: ["command"], surfaces: ["web"] },
      activate(ctx) { ctx.registerCommand("bump", () => { const n = Number(ctx.store.get("n") ?? "0") + 1; ctx.store.set("n", String(n)); return [String(n)]; }); },
    };
    host.register(t); host.setEnabled("counter", true);
    expect(host.runCommand("bump")![0]).toBe("1");
    expect(host.runCommand("bump")![0]).toBe("2");
  });

  it("(tools 5+8) grid-bearing computes distance/bearing; 7plus summarises a block", () => {
    const host = new ToolHost();
    for (const t of builtinTools()) host.register(t);
    host.setEnabled("grid-bearing", true);
    const g = host.runCommand("grid", "JN76jx JO30")!;
    expect(g[0]).toMatch(/JN76JX → JO30:.*km, bearing/);
    host.setEnabled("sevenplus", true);
    const out = host.decoders().find((d) => d.id === "7plus")!.decode("file.zip part 1 of 3\ngo_7+. abcd\nQUJD\nstop_7+");
    expect(out).toMatch(/part 1 of 3/);
    expect(out).toMatch(/incomplete/);
  });

  it("(tool 2, #2) mheard records heard stations from on_frame across sources, deduped", () => {
    const host = new ToolHost();
    host.register(builtinTools().find((t) => t.manifest.name === "mheard")!);
    host.setEnabled("mheard", true);
    host.dispatch("on_frame", { peerCall: "OE8XBM-7", source: "RF" });
    host.dispatch("on_frame", { peerCall: "OE8XBM-7", source: "RF" });   // dup collapses
    host.dispatch("on_frame", { peerCall: "OE1XDS-1", source: "APRS" });
    const panel = host.panels("web")[0]!.spec;
    const table = panel.nodes.find((n) => n.kind === "table") as { rows: string[][] };
    expect(table.rows.map((r) => r[0]).sort()).toEqual(["OE1XDS-1", "OE8XBM-7"]); // 2 unique (dup collapsed)
    expect(table.rows.find((r) => r[0] === "OE1XDS-1")![1]).toBe("APRS");         // source label carried through
    expect(table.rows.find((r) => r[0] === "OE8XBM-7")![1]).toBe("RF");
  });

  it("panel capability: setPanel is gated + panels() returns the spec for the surface", () => {
    const host = new ToolHost();
    host.register(builtinTools().find((t) => t.manifest.name === "aprs-ssid-guide")!); // panel, web
    host.setEnabled("aprs-ssid-guide", true);
    const webPanels = host.panels("web");
    expect(webPanels).toHaveLength(1);
    expect(webPanels[0]!.spec.title).toMatch(/SSID/);
    expect(host.panels("node")).toHaveLength(0);               // ssid-guide targets web/terminal/bbs, not node

    const rogue: Tool = {
      manifest: { name: "rogue-panel", title: "R", author: "X", version: "1", permissions: ["command"], surfaces: ["web"] },
      activate(ctx) { ctx.setPanel({ nodes: [{ kind: "text", text: "x" }] }); }, // needs 'panel'
    };
    host.register(rogue);
    expect(host.setEnabled("rogue-panel", true).error).toMatch(/permission 'panel' not granted/);
  });
});

describe("Inter-tool IPC bus (docs/28 §5f) — the host routes, never interprets", () => {
  const producer = (): Tool => ({
    manifest: { name: "prod", title: "P", author: "X", version: "1", permissions: ["ipc", "command"], surfaces: ["web"] },
    activate(ctx) {
      ctx.provideService("sum", (a) => { const { x, y } = a as { x: number; y: number }; return x + y; });
      ctx.registerCommand("fire", (args) => { ctx.emit("topic.a", { msg: args }); return ["fired"]; });
    },
  });
  const consumer = (sink: string[]): Tool => ({
    manifest: { name: "cons", title: "C", author: "X", version: "1", permissions: ["ipc"], surfaces: ["web"] },
    activate(ctx) { ctx.subscribe("topic.a", (data, from) => sink.push(`${from}:${(data as { msg: string }).msg}`)); },
  });

  it("emit → subscribe delivers the opaque payload + emitting tool name", () => {
    const sink: string[] = [];
    const host = new ToolHost();
    host.register(producer()); host.register(consumer(sink));
    host.setEnabled("prod", true); host.setEnabled("cons", true);
    host.runCommand("fire", "hi");
    expect(sink).toEqual(["prod:hi"]);
  });

  it("provideService / callService is a request/response between tools", () => {
    const host = new ToolHost();
    const caller: Tool = {
      manifest: { name: "caller", title: "C", author: "X", version: "1", permissions: ["ipc", "command"], surfaces: ["web"] },
      activate(ctx) { ctx.registerCommand("ask", () => [String(ctx.callService("sum", { x: 2, y: 3 }))]); },
    };
    host.register(producer()); host.register(caller);
    host.setEnabled("prod", true); host.setEnabled("caller", true);
    expect(host.runCommand("ask")).toEqual(["5"]);
    expect(host.ipcServices()).toContain("sum");
  });

  it("disabling a tool tears down its subscriptions + services", () => {
    const sink: string[] = [];
    const host = new ToolHost();
    host.register(producer()); host.register(consumer(sink));
    host.setEnabled("prod", true); host.setEnabled("cons", true);
    host.setEnabled("cons", false);                 // subscriber gone
    host.runCommand("fire", "x");
    expect(sink).toEqual([]);                        // not delivered
    host.setEnabled("prod", false);                 // provider gone
    const c: Tool = { manifest: { name: "c2", title: "C", author: "X", version: "1", permissions: ["ipc", "command"], surfaces: ["web"] },
      activate(ctx) { ctx.registerCommand("q", () => [String(ctx.callService("sum", { x: 1, y: 1 }))]); } };
    host.register(c); host.setEnabled("c2", true);
    expect(host.runCommand("q")).toEqual(["undefined"]);   // service no longer provided
    expect(host.ipcServices()).not.toContain("sum");
  });

  it("emit/subscribe require the 'ipc' capability", () => {
    const rogue: Tool = { manifest: { name: "noipc", title: "N", author: "X", version: "1", permissions: ["command"], surfaces: ["web"] },
      activate(ctx) { (ctx as unknown as { emit: (t: string) => void }).emit("x"); } };
    const host = new ToolHost();
    host.register(rogue);
    expect(host.setEnabled("noipc", true).error).toMatch(/permission 'ipc' not granted/);
  });
});

describe("GP-archive tools — remote gating + IPC producer/consumer", () => {
  it("per-command remote gate: a peer reaches /info but not operator-only /setinfo", () => {
    const host = new ToolHost();
    host.register(builtinTools().find((t) => t.manifest.name === "info-responder")!);
    host.setEnabled("info-responder", true);
    expect(host.runCommand("info", "", "bbs", { remote: true })).not.toBeNull();      // read command answers a peer
    expect(host.runCommand("setinfo", "hax", "bbs", { remote: true })).toBeNull();    // operator-only: peer blocked
    expect(host.runCommand("setinfo", "hi", "bbs")).toEqual(["Info text updated."]);  // …local still works
  });

  it("station-db publishes station.type over the bus; info-responder /whois consumes it", () => {
    const host = new ToolHost();
    for (const t of builtinTools()) host.register(t);
    host.setEnabled("station-db", true);
    host.setEnabled("info-responder", true);
    host.dispatch("on_frame", { peerCall: "OE8XBM-1", surface: "terminal", text: "" });
    const whois = host.runCommand("whois", "OE8XBM-1", "terminal", { remote: true })!;
    expect(whois[0]).toMatch(/OE8XBM-1:/);            // resolved via the station.type service
    expect(host.runCommand("whois", "ZZ9ZZZ", "terminal")![0]).toMatch(/not heard yet/);
  });

  it("unit converter + CW encoder produce expected output", () => {
    const host = new ToolHost();
    for (const t of builtinTools()) host.register(t);
    host.setEnabled("unit-convert", true); host.setEnabled("cw-encoder", true);
    expect(host.runCommand("conv", "100 km mi")![0]).toMatch(/62\.14 mi/);
    expect(host.runCommand("conv", "0 c f")![0]).toMatch(/32\.0 F/);
    expect(host.runCommand("cw", "SOS")).toEqual(["... --- ..."]);
  });

  it("away-note: a peer may leave a note but not toggle away", () => {
    const host = new ToolHost();
    host.register(builtinTools().find((t) => t.manifest.name === "away-note")!);
    host.setEnabled("away-note", true);
    expect(host.runCommand("note", "back at 1900z", "bbs", { remote: true })).toEqual(["Note saved - 73!"]);
    expect(host.runCommand("away", "on", "bbs", { remote: true })).toBeNull();   // operator-only
    expect(host.runCommand("notes", "", "bbs")![0]).toBe("back at 1900z");
  });
});

describe("(C) macro variable expansion", () => {
  it("substitutes known {tokens} and leaves unknown ones intact", () => {
    expect(expand("CQ de {call} k", { call: "OE8APR" })).toBe("CQ de OE8APR k");
    expect(expand("QTH {grid}, hi {peer}", { grid: "JN76", peer: "OE3ABC" })).toBe("QTH JN76, hi OE3ABC");
    expect(expand("unknown {nope} stays", {})).toBe("unknown {nope} stays");
  });
  it("withNow fills date/time but never clobbers explicit vars", () => {
    const v = withNow({ call: "OE8APR", date: "2020-01-01" }, new Date(Date.UTC(2026, 6, 2, 9, 5)));
    expect(v.date).toBe("2020-01-01");        // explicit wins
    expect(v.time).toBe("09:05Z");
    expect(v.call).toBe("OE8APR");
  });
});
