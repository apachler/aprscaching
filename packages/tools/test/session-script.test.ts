// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseScript, ScriptRunner, type ScriptSession } from "../src/session-script.js";

/** A controllable fake connection: connect flips to "connected" after `connectAfter` ticks; feed() pushes RX. */
function fakeSession() {
  const chans = new Map<number, { call: string; state: string; lines: string[]; opened: number }>();
  let clock = 0,
    next = 1;
  const session: ScriptSession & { feed(id: number, line: string): void; setState(id: number, s: string): void } = {
    connect: (call) => {
      const id = next++;
      chans.set(id, { call, state: "connecting", lines: [], opened: clock });
      return id;
    },
    send: (id, text) => {
      chans.get(id)?.lines.push(`>${text}`);
    },
    close: (id) => {
      const c = chans.get(id);
      if (c) c.state = "disconnected";
    },
    channelState: (id) => chans.get(id)?.state,
    channelLines: (id) => chans.get(id)?.lines ?? [],
    feed: (id, line) => chans.get(id)?.lines.push(line),
    setState: (id, s) => {
      const c = chans.get(id);
      if (c) c.state = s;
    },
  };
  return { session, chans, tick: () => ++clock };
}

describe("parseScript (GPAUTO .gpa)", () => {
  it("parses ops, comments, and both line + ; separators", () => {
    const steps = parseScript(
      "***REM login\nconnect HB9W-8; waitfor Cluster 20\nsend sh/dx\nwait 5\n# note\ndisconnect",
    );
    expect(steps).toEqual([
      { op: "connect", call: "HB9W-8" },
      { op: "waitfor", text: "Cluster", timeoutSec: 20 },
      { op: "send", text: "sh/dx" },
      { op: "wait", sec: 5 },
      { op: "disconnect" },
    ]);
  });
});

describe("ScriptRunner", () => {
  it("drives connect → waitfor → send → disconnect, capturing RX", () => {
    const { session, chans } = fakeSession();
    const r = new ScriptRunner(session);
    r.load(parseScript("connect HB9W-8; waitfor Cluster; send sh/dx; disconnect"), 0);

    r.tick(1); // connect issued (state "connecting")
    const id = [...chans.keys()][0]!;
    expect(chans.get(id)!.call).toBe("HB9W-8");
    session.setState(id, "connected");
    r.tick(2); // sees connected → advance to waitfor
    expect(r.state().step).toBe(2);

    session.feed(id, "Welcome to the DX Cluster");
    r.tick(3); // waitfor matched → advance, send fires next tick
    r.tick(4); // send
    expect(chans.get(id)!.lines).toContain(">sh/dx");
    r.tick(5); // disconnect
    expect(r.state().status).toBe("done");
    expect(r.state().captured.some((l) => l.includes("DX Cluster"))).toBe(true);
  });

  it("times out a waitfor and still completes", () => {
    const { session } = fakeSession();
    const r = new ScriptRunner(session);
    r.load(parseScript("connect X-1; waitfor NEVER 5; disconnect"), 0);
    r.tick(1000);
    const id = 1;
    session.setState(id, "connected");
    r.tick(1001); // connected → waitfor (stepStart = 1001 ms)
    const s = r.tick(7000); // ~6s later → past the 5s timeout
    expect(s?.note).toMatch(/timeout/);
    r.tick(7001); // disconnect
    expect(r.state().status).toBe("done");
  });

  it("tick() returns null when nothing changed", () => {
    const { session } = fakeSession();
    const r = new ScriptRunner(session);
    r.load(parseScript("connect X-1"), 0);
    r.tick(1); // connecting…
    expect(r.tick(2)).toBeNull(); // still connecting, no state change
  });
});
