// SPDX-License-Identifier: MIT
// The SID gate in front of the interactive BBS: a human caller gets the menu; a forwarding peer
// that answers the greeting SID with its own drives a full F-protocol responder session — proposals
// accepted into the store, reverse traffic proposed back, and the collected exchange handed to
// onSessionEnd exactly once. The greeting carries the ONLY SID we send (a real caller would see a
// double-SID as protocol garbage).
import { describe, it, expect } from "vitest";
import { FbbForwarder, FbbGatedBbs, SessionStore, type FbbMessage, type LineApp } from "../src/index.js";

const msg = (bid: string, to: string, body: string): FbbMessage => ({
  type: "P",
  from: "OE1AAA",
  at: "OE1BBB",
  to,
  bid,
  title: `subject ${bid}`,
  body,
});

const menu: LineApp = {
  greeting: () => ["Hello caller. Type H for help.", ">"],
  handle: (l) => ({ lines: l.trim().toUpperCase() === "H" ? ["help: B to bye"] : ["?"], disconnect: false }),
};

/** Drive the byte-stream initiator against the line-oriented gate until the session completes. */
async function pump(fwd: FbbForwarder, gate: FbbGatedBbs): Promise<void> {
  const dec = new TextDecoder();
  const toGate: string[] = [];
  const push = (b: Uint8Array | null) => {
    if (b) toGate.push(...dec.decode(b).split("\r").filter(Boolean));
  };
  // greeting reaches the initiator first (the called side speaks first on a real connect)
  push(fwd.onData(new TextEncoder().encode(gate.greeting().join("\r") + "\r")));
  push(fwd.start());
  for (let guard = 0; guard < 200 && !fwd.done; guard++) {
    const line = toGate.shift();
    if (line === undefined) break;
    const r = await gate.handle(line);
    for (const out of r.lines) push(fwd.onData(new TextEncoder().encode(out + "\r")));
    if (r.disconnect) break;
  }
}

describe("FbbGatedBbs", () => {
  it("runs a full forwarding exchange in both directions off one BBS callsign", async () => {
    const initiatorStore = new SessionStore([msg("A1_OE1AAA", "OE1TST", "hello from A")]);
    const fwd = new FbbForwarder(initiatorStore, { initiator: true });

    const responderStore = new SessionStore([msg("B1_OE1BBB", "OE1AAA", "reverse traffic")]);
    let ended = 0;
    const gate = new FbbGatedBbs(menu, {
      makeStore: () => responderStore,
      onSessionEnd: () => {
        ended++;
      },
    });

    await pump(fwd, gate);
    expect(fwd.done).toBe(true);
    expect(responderStore.inbox.map((m) => m.bid)).toEqual(["A1_OE1AAA"]); // A's message accepted at B
    expect(initiatorStore.inbox.map((m) => m.bid)).toEqual(["B1_OE1BBB"]); // B's reverse message reached A
    expect(ended).toBe(1);
  });

  it("keeps a human caller on the interactive menu", async () => {
    const gate = new FbbGatedBbs(menu, { makeStore: () => new SessionStore([]) });
    expect(gate.greeting()[0]).toMatch(/^\[.+\$\]$/); // SID banner, real-BBS style
    const r = await gate.handle("H");
    expect(r.lines.join(" ")).toContain("help");
  });

  it("emits its SID exactly once (greeting only) toward a forwarding peer", async () => {
    const gate = new FbbGatedBbs(menu, { makeStore: () => new SessionStore([]) });
    const first = await gate.handle("[BPQ-6.0.24.14-B2FIHM$]");
    expect(first.lines.some((l) => /^\[.+\]$/.test(l.trim()))).toBe(false); // no second SID
    // after the SID exchange the CALLER proposes first — the responder waits silently
    expect(first.lines).toEqual([]);
    const ff = await gate.handle("FF"); // caller has nothing → direction reverses to us
    expect(ff.lines[0]).toBe("FQ"); // nothing queued either way → clean close
  });
});
