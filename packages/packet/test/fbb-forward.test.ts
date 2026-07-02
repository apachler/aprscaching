// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { FbbForwarder } from "../src/fbb-forward.js";
import { type FbbMessage, type FbbStore } from "../src/fbb-session.js";

/** Same in-memory store as the line-level FBB test, reused at the byte level. */
function makeStore(out: FbbMessage[]): FbbStore & { inbox: FbbMessage[]; queue: FbbMessage[] } {
  const queue = [...out];
  const inbox: FbbMessage[] = [];
  const held = new Set(out.map((m) => m.bid));
  return {
    queue, inbox,
    outbound: () => queue,
    hasBid: (bid) => held.has(bid),
    accept: (m) => { inbox.push(m); held.add(m.bid); },
    sent: (bid) => { const i = queue.findIndex((m) => m.bid === bid); if (i >= 0) queue.splice(i, 1); },
  };
}

const msg = (o: Partial<FbbMessage> & Pick<FbbMessage, "from" | "to" | "bid" | "title" | "body">): FbbMessage =>
  ({ type: "P", at: "WW", ...o });

/** Drive two byte-level forwarders over a deferred byte channel (the re-entrancy-safe loopback pattern). */
function driveBytes(a: FbbForwarder, b: FbbForwarder): void {
  const q: Array<{ to: "a" | "b"; bytes: Uint8Array }> = [];
  const open = a.start();
  if (open) q.push({ to: "b", bytes: open });
  let guard = 4000;
  while (q.length && guard-- > 0) {
    const { to, bytes } = q.shift()!;
    const out = (to === "a" ? a : b).onData(bytes);
    if (out) q.push({ to: to === "a" ? "b" : "a", bytes: out });
  }
  if (guard <= 0) throw new Error("byte-level FBB exchange did not terminate");
}

describe("FBB byte-stream forwarder", () => {
  it("forwards a message each way over a raw byte link (CR framing + line buffering)", () => {
    const A = makeStore([msg({ from: "OE8BBS", to: "DL1ABC", at: "DB0XYZ", bid: "1_OE8", title: "Hi", body: "hello DL\nline two" })]);
    const B = makeStore([msg({ type: "B", from: "DB0XYZ", to: "ALL", at: "WW", bid: "9_DB0", title: "Net", body: "net on 144.800" })]);

    const a = new FbbForwarder(A, { initiator: true });
    const b = new FbbForwarder(B, { initiator: false });
    driveBytes(a, b);

    expect(a.done && b.done).toBe(true);
    expect(B.inbox.map((m) => m.bid)).toEqual(["1_OE8"]);
    expect(B.inbox[0]).toMatchObject({ from: "OE8BBS", to: "DL1ABC", body: "hello DL\nline two" });
    expect(A.inbox.map((m) => m.bid)).toEqual(["9_DB0"]);
    expect(A.queue).toHaveLength(0);
    expect(B.queue).toHaveLength(0);
  });

  it("tolerates frames split across arbitrary byte boundaries", () => {
    const A = makeStore([msg({ from: "OE8BBS", to: "DL1ABC", bid: "1_OE8", title: "Hi", body: "one liner" })]);
    const B = makeStore([]);
    const a = new FbbForwarder(A, { initiator: true });
    const b = new FbbForwarder(B, { initiator: false });

    // feed 'a' as normal but chop every chunk 'b' would receive into single bytes
    const q: Array<{ to: "a" | "b"; bytes: Uint8Array }> = [];
    const open = a.start(); if (open) q.push({ to: "b", bytes: open });
    let guard = 8000;
    while (q.length && guard-- > 0) {
      const { to, bytes } = q.shift()!;
      const target = to === "a" ? a : b;
      let out: Uint8Array | null = null;
      for (const byte of bytes) { const r = target.onData(new Uint8Array([byte])); if (r) out = out ? new Uint8Array([...out, ...r]) : r; }
      if (out) q.push({ to: to === "a" ? "b" : "a", bytes: out });
    }
    expect(B.inbox.map((m) => m.bid)).toEqual(["1_OE8"]);
    expect(B.inbox[0]).toMatchObject({ body: "one liner" });
  });
});
