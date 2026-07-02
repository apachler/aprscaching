// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { FbbSession, type FbbMessage, type FbbStore } from "../src/fbb-session.js";

/** In-memory FBB store with an outbound queue + an inbox, tracking held BIDs for dedup. */
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

/** Drive a full FBB exchange between two sessions at the line level (deterministic ping-pong). */
function drive(a: FbbSession, b: FbbSession): void {
  const pending: Array<{ to: "a" | "b"; line: string }> = a.start().map((line) => ({ to: "b" as const, line }));
  let guard = 2000;
  while (pending.length && guard-- > 0) {
    const { to, line } = pending.shift()!;
    const r = (to === "a" ? a : b).feed(line);
    for (const line2 of r.out) pending.push({ to: to === "a" ? "b" : "a", line: line2 });
  }
  if (guard <= 0) throw new Error("FBB exchange did not terminate");
}

const msg = (o: Partial<FbbMessage> & Pick<FbbMessage, "from" | "to" | "bid" | "title" | "body">): FbbMessage =>
  ({ type: "P", at: "WW", ...o });

describe("FBB forwarding session over the loopback", () => {
  it("forwards a message each way with reverse forwarding", () => {
    const A = makeStore([msg({ from: "OE8BBS", to: "DL1ABC", at: "DB0XYZ", bid: "1_OE8", title: "Hi from OE", body: "hello DL\nline two" })]);
    const B = makeStore([msg({ type: "B", from: "DB0XYZ", to: "ALL", at: "WW", bid: "9_DB0", title: "Net Sat", body: "net on 144.800" })]);

    drive(new FbbSession(A, { initiator: true }), new FbbSession(B, { initiator: false }));

    // A's message reached B; B's bulletin reached A (reverse forwarding).
    expect(B.inbox.map((m) => m.bid)).toEqual(["1_OE8"]);
    expect(B.inbox[0]).toMatchObject({ from: "OE8BBS", to: "DL1ABC", title: "Hi from OE", body: "hello DL\nline two" });
    expect(A.inbox.map((m) => m.bid)).toEqual(["9_DB0"]);
    expect(A.inbox[0]).toMatchObject({ type: "B", to: "ALL", body: "net on 144.800" });
    // both outbound queues drained (messages marked sent)
    expect(A.queue).toHaveLength(0);
    expect(B.queue).toHaveLength(0);
  });

  it("rejects a message the partner already holds (BID dedup) and doesn't resend", () => {
    const dup = msg({ from: "OE8BBS", to: "DL1ABC", bid: "1_OE8", title: "Dup", body: "already have this" });
    const A = makeStore([dup]);
    const B = makeStore([]);         // B already holds BID 1_OE8
    (B as unknown as { accept: (m: FbbMessage) => void }).accept({ ...dup, body: "prior copy" });
    const bInboxBefore = B.inbox.length;

    drive(new FbbSession(A, { initiator: true }), new FbbSession(B, { initiator: false }));

    // B rejected the proposal (FS '-'); no duplicate stored; A still dequeued it (nothing to forward).
    expect(B.inbox.length).toBe(bInboxBefore);
    expect(B.inbox.filter((m) => m.bid === "1_OE8" && m.body === "already have this")).toHaveLength(0);
  });

  it("terminates cleanly when neither side has anything (FF → FQ)", () => {
    const A = makeStore([]);
    const B = makeStore([]);
    expect(() => drive(new FbbSession(A, { initiator: true }), new FbbSession(B, { initiator: false }))).not.toThrow();
    expect(A.inbox).toHaveLength(0);
    expect(B.inbox).toHaveLength(0);
  });
});
