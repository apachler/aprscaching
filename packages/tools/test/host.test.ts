import { describe, it, expect, vi } from "vitest";
import { ToolHost, validateManifest, builtinTools, type Tool } from "../src/index.js";

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
    expect(host.list()).toHaveLength(6);
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
