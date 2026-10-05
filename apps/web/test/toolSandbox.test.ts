// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ToolHost } from "@aprscaching/tools";
import { callResult, connectSources, frameCsp, frameSource, parseFrameMessage } from "../src/tools/sandbox.js";

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
  });
  it("keeps only well-formed contributions from a loaded tool", () => {
    const m = parseFrameMessage({
      type: "loaded",
      commands: ["hello", 4, null],
      colourRules: [{ srcPrefix: "OE", colorVar: "--st-user", hidden: "yes" }, 7],
      panel: { title: "P" },
      decoders: [{ id: "rot13", label: "ROT13", kind: "text" }, { id: 1 }],
    });
    expect(m).toEqual({
      type: "loaded",
      commands: ["hello"],
      colourRules: [
        {
          srcPrefix: "OE",
          dstPrefix: undefined,
          textIncludes: undefined,
          colorVar: "--st-user",
          hidden: false,
        },
      ],
      panel: { title: "P" },
      decoders: [{ id: "rot13", label: "ROT13", kind: "text" }],
    });
  });
  it("turns command result lines into strings", () => {
    expect(parseFrameMessage({ type: "cmdResult", id: 2, lines: [1, "a"] })).toEqual({
      type: "cmdResult",
      id: 2,
      lines: ["1", "a"],
    });
  });
});

describe("a sandboxed tool's service call", () => {
  const hostWithScript = () => {
    const host = new ToolHost();
    host.registerHostService("session.script", () => ({ ok: true }), { requires: "tx" });
    return host;
  };
  it("answers with the service's result when the tool holds the capability it requires", () => {
    const bus = hostWithScript().toolBus("imported-x", ["ipc", "tx"]);
    expect(callResult(bus, 7, "session.script", { steps: [] })).toEqual({
      type: "callResult",
      id: 7,
      result: { ok: true },
    });
  });
  it("answers a refusal as an error the tool's promise rejects with", () => {
    const bus = hostWithScript().toolBus("imported-x", ["ipc"]);
    const r = callResult(bus, 8, "session.script", { steps: [] });
    expect(r.id).toBe(8);
    expect(r.result).toBeUndefined();
    expect(r.error).toMatch(/needs the 'tx' permission, which imported-x does not hold/);
  });
  it("rejects the worker's call promise when the answer carries an error", () => {
    expect(frameSource("default-src 'none'")).toContain("p.rej(new Error(m.error))");
  });
});
