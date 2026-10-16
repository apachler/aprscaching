// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { TxArbiter } from "../src/arbiter.js";

const f = (n: number, len = 20) => new Uint8Array(len).fill(n);
const drain = (a: TxArbiter, port: string) => {
  const out: string[] = [];
  for (let t = a.next(port); t; t = a.next(port)) out.push(`${t.client}:${t.frame[0]}`);
  return out;
};

describe("TxArbiter", () => {
  it("serves the clients of a port in turn, one frame each", () => {
    const a = new TxArbiter({ framesPerMinute: 100 });
    for (let i = 1; i <= 4; i++) a.offer("busy", "p", f(i));
    a.offer("quiet", "p", f(9));
    a.offer("third", "p", f(7));
    expect(drain(a, "p")).toEqual(["busy:1", "quiet:9", "third:7", "busy:2", "busy:3", "busy:4"]);
  });

  it("keeps the rotation when a client that queues again joins at the end", () => {
    const a = new TxArbiter({ framesPerMinute: 100 });
    a.offer("a", "p", f(1));
    a.offer("a", "p", f(2));
    a.offer("b", "p", f(3));
    expect(a.next("p")!.client).toBe("a");
    expect(a.next("p")!.client).toBe("b"); // b's queue empties and b leaves the rotation
    a.offer("b", "p", f(4));
    a.offer("c", "p", f(5));
    expect(drain(a, "p")).toEqual(["a:2", "b:4", "c:5"]);
  });

  it("keeps each port's queue and turn apart", () => {
    const a = new TxArbiter({ framesPerMinute: 100 });
    a.offer("a", "vhf", f(1));
    a.offer("b", "uhf", f(2));
    expect(a.ports().sort()).toEqual(["uhf", "vhf"]);
    expect(drain(a, "uhf")).toEqual(["b:2"]);
    expect(a.pending("vhf")).toBe(1);
  });

  it("refuses a frame past the client's frame budget in any minute", () => {
    let now = 0;
    const a = new TxArbiter({ framesPerMinute: 3, now: () => now });
    for (let i = 0; i < 3; i++) expect(a.offer("a", "p", f(i)).queued).toBe(true);
    expect(a.offer("a", "p", f(3))).toEqual({ queued: false, dropped: "frame-budget" });
    expect(a.offer("b", "p", f(3)).queued).toBe(true); // another client has its own budget
    now = 60_000;
    expect(a.offer("a", "p", f(4)).queued).toBe(true);
    expect(a.dropped("a")["frame-budget"]).toBe(1);
  });

  it("refuses a frame past the client's byte budget, across ports", () => {
    const a = new TxArbiter({ bytesPerMinute: 100 });
    expect(a.offer("a", "p", f(1, 60)).queued).toBe(true);
    expect(a.offer("a", "q", f(2, 60))).toEqual({ queued: false, dropped: "byte-budget" });
    expect(a.offer("a", "q", f(3, 40)).queued).toBe(true);
  });

  it("drops the oldest frame of a full queue and counts it", () => {
    const a = new TxArbiter({ maxQueue: 2, framesPerMinute: 100 });
    a.offer("a", "p", f(1));
    a.offer("a", "p", f(2));
    expect(a.offer("a", "p", f(3))).toEqual({ queued: true, dropped: "queue-full" });
    expect(drain(a, "p")).toEqual(["a:2", "a:3"]);
    expect(a.dropped("a")["queue-full"]).toBe(1);
  });

  it("drops a frame that waited past its age when its turn comes", () => {
    let now = 0;
    const a = new TxArbiter({ maxAgeMs: 1000, framesPerMinute: 100, now: () => now });
    a.offer("a", "p", f(1));
    now = 900;
    a.offer("b", "p", f(2));
    now = 1500;
    expect(drain(a, "p")).toEqual(["b:2"]);
    expect(a.dropped("a").stale).toBe(1);
  });

  it("forgets a client's frames and counts when it goes away", () => {
    const a = new TxArbiter({ framesPerMinute: 100 });
    a.offer("a", "p", f(1));
    a.offer("b", "p", f(2));
    a.offer("a", "p", f(3));
    expect(a.next("p")!.client).toBe("a");
    a.remove("a");
    expect(drain(a, "p")).toEqual(["b:2"]);
    expect(a.ports()).toEqual([]);
  });
});
