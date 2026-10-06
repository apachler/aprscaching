// SPDX-License-Identifier: MIT
/**
 * The example tool under examples/station-log, which the manual's tool walkthrough and reference quote: its
 * manifest passes the real validator, and its script, run the way the sandbox's worker runs it (the body of
 * a function of `register` and `ipc`), contributes panels the host's sanitiser keeps intact.
 */
import { describe, expect, it } from "vitest";
import { checkManifestSignature, sanitizePanel, validateManifest, type PanelSpec } from "../src/index.js";
import { loadExampleTool } from "./fixtures/example.mjs";

const { manifest: manifestJson, script } = loadExampleTool();

interface Registered {
  commands: Record<string, (args: string) => unknown>;
  panel: unknown;
}

/** Evaluate the script as the worker does; `withIpc` mirrors whether the user granted 'ipc'. */
function load(withIpc: boolean) {
  let reg: Registered | undefined;
  const subs: Record<string, ((data: unknown, from: string) => void)[]> = {};
  const panels: unknown[] = [];
  const calls: { name: string; args: unknown }[] = [];
  let answer: unknown;
  const ipc = {
    emit: () => undefined,
    subscribe: (topic: string, cb: (data: unknown, from: string) => void) => {
      (subs[topic] ??= []).push(cb);
    },
    call: (name: string, args: unknown) => {
      calls.push({ name, args });
      return Promise.resolve(answer);
    },
    setPanel: (spec: unknown) => {
      panels.push(spec);
    },
  };
  new Function("register", "ipc", script)((t: Registered) => (reg = t), withIpc ? ipc : undefined);
  if (!reg) throw new Error("the script did not call register()");
  const run = (word: string, args = "") => ([] as unknown[]).concat(reg!.commands[word]!(args)).map(String);
  const deliver = (topic: string, data: unknown) => subs[topic]?.forEach((cb) => cb(data, "station-db"));
  return {
    reg,
    run,
    deliver,
    panels,
    calls,
    answerWith: (v: unknown) => (answer = v),
    subscribed: Object.keys(subs),
  };
}

/** The sanitiser keeps a well-formed panel as it is (undefined optional fields aside). */
const keepsShape = (spec: unknown) => expect(sanitizePanel(spec)).toEqual(spec as PanelSpec);

describe("example tool: station-log", () => {
  it("its manifest passes the validator, and stays unsigned until its author signs it", async () => {
    const v = validateManifest(manifestJson);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.name).toBe("station-log");
    expect(v.manifest.permissions).toEqual(["command", "panel", "ipc"]);
    expect(v.manifest.surfaces).toEqual(["web", "terminal"]);
    expect(v.manifest.entry).toBe("tool.js");
    expect(await checkManifestSignature(v.manifest)).toBe("unsigned");
  });

  it("registers its commands and an initial panel", () => {
    const t = load(true);
    expect(Object.keys(t.reg.commands).sort()).toEqual(["seen", "whois"]);
    expect(t.subscribed).toEqual(["station.seen"]);
    keepsShape(t.reg.panel);
    expect(t.run("seen")).toEqual(["No stations heard yet."]);
  });

  it("lists stations from station.seen and updates its panel", () => {
    const t = load(true);
    t.deliver("station.seen", { call: "OE6XRR-9", type: "digi", source: "APRS" });
    t.deliver("station.seen", { call: "OE3ABC", type: "", source: "RF" });
    t.deliver("station.seen", { nonsense: true });
    expect(t.run("seen")).toEqual(["OE3ABC  -  RF", "OE6XRR-9  digi  APRS"]);
    expect(t.panels).toHaveLength(2);
    const last = t.panels[1] as PanelSpec;
    keepsShape(last);
    expect(last.nodes).toContainEqual({
      kind: "table",
      head: ["Call", "Type", "Via"],
      rows: [
        ["OE3ABC", "-", "RF"],
        ["OE6XRR-9", "digi", "APRS"],
      ],
    });
  });

  it("/whois calls the station.type service and shows the answer in the panel", async () => {
    const t = load(true);
    t.answerWith("igate");
    expect(t.run("whois", "oe6xgr-10")[0]).toContain("OE6XGR-10");
    expect(t.calls).toEqual([{ name: "station.type", args: "OE6XGR-10" }]);
    await Promise.resolve();
    const spec = t.panels.at(-1) as PanelSpec;
    keepsShape(spec);
    expect(spec.nodes[0]).toEqual({ kind: "kv", key: "OE6XGR-10", value: "igate", tone: "ok" });
    expect(t.run("whois")).toEqual(["Usage: /whois <callsign>"]);
  });

  it("runs without the ipc grant, and says what it needs", () => {
    const t = load(false);
    expect(t.subscribed).toEqual([]);
    expect(t.run("whois", "OE3ABC")).toEqual(["Station log needs the ipc permission to ask Station DB."]);
  });
});
