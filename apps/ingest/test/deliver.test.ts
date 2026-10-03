// SPDX-License-Identifier: AGPL-3.0-or-later
// The delivery queue: a backlog drains in batches the gateway accepts, a refused packet is isolated and
// dropped instead of blocking every later flush, and only an unreachable gateway keeps packets queued.
import { describe, it, expect } from "vitest";
import { INGEST_BATCH_MAX, type Packet } from "@aprscaching/shared";
import { Delivery } from "../src/deliver.js";

const pkt = (i: number): Packet => ({
  src: `N0CALL-${i % 16}`,
  dst: "APRS",
  path: [],
  payload: `>${i}`,
  kind: "other",
  heardVia: "rf",
  port: "kiss-tnc",
  ts: i,
});
const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => pkt(from + i));
const ids = (ps: Packet[]) => ps.map((p) => p.ts);

/** A gateway stub: records every batch and answers with `status(batch)`. */
function gateway(status: (b: Packet[]) => number | Error = () => 200) {
  const batches: Packet[][] = [];
  const post = async (b: Packet[]) => {
    batches.push(b);
    const s = status(b);
    if (s instanceof Error) throw s;
    return { ok: s >= 200 && s < 300, status: s };
  };
  return { batches, post };
}

describe("Delivery", () => {
  it("drains a backlog larger than INGEST_BATCH_MAX in accepted batches", async () => {
    const gw = gateway((b) => (b.length > INGEST_BATCH_MAX ? 400 : 200));
    const d = new Delivery({ post: gw.post, maxQueue: 5000, log: () => {} });
    d.add(many(2500));
    await d.flush();
    expect(gw.batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(d.size).toBe(0);
    expect(d.dropped).toBe(0);
  });

  it("keeps packets queued, in order, while the gateway is unreachable", async () => {
    let down = true;
    const gw = gateway(() => (down ? new Error("ECONNREFUSED") : 200));
    const d = new Delivery({ post: gw.post, maxQueue: 5000, maxBatch: 10, log: () => {} });
    d.add(many(25));
    await d.flush();
    expect(d.size).toBe(25);
    d.add(many(5, 25));
    down = false;
    await d.flush();
    expect(d.size).toBe(0);
    expect(ids(gw.batches.slice(1).flat())).toEqual(ids(many(30)));
  });

  for (const status of [429, 500, 503, 401])
    it(`retries a batch answered with HTTP ${status}`, async () => {
      const gw = gateway(() => status);
      const d = new Delivery({ post: gw.post, maxQueue: 100, log: () => {} });
      d.add(many(3));
      await d.flush();
      expect(d.size).toBe(3);
      expect(d.dropped).toBe(0);
    });

  it("isolates and drops the one packet the gateway refuses, delivering the rest", async () => {
    const bad = 13;
    const gw = gateway((b) => (b.some((p) => p.ts === bad) ? 400 : 200));
    const d = new Delivery({ post: gw.post, maxQueue: 5000, log: () => {} });
    d.add(many(40));
    await d.flush();
    const delivered = gw.batches.filter((b) => !b.some((p) => p.ts === bad)).flat();
    expect(ids(delivered).sort((a, b) => a - b)).toEqual(ids(many(40)).filter((i) => i !== bad));
    expect(d.dropped).toBe(1);
    expect(d.size).toBe(0);
  });

  it("drops a batch the gateway refuses outright without retrying it forever", async () => {
    const gw = gateway(() => 413);
    const d = new Delivery({ post: gw.post, maxQueue: 5000, log: () => {} });
    d.add(many(2000));
    await d.flush();
    expect(d.size).toBe(0);
    expect(d.dropped).toBe(2000);
    expect(gw.batches.length).toBeLessThan(60); // isolation is bounded per flush
  });

  it("requeues both halves of a split batch when the gateway goes away mid-split", async () => {
    let calls = 0;
    const gw = gateway(() => (++calls === 1 ? 400 : new Error("timeout")));
    const d = new Delivery({ post: gw.post, maxQueue: 100, log: () => {} });
    d.add(many(8));
    await d.flush();
    expect(ids(d.queued())).toEqual(ids(many(8)));
  });

  it("caps the queue by dropping the oldest packets", () => {
    const d = new Delivery({ post: async () => ({ ok: true, status: 200 }), maxQueue: 10, log: () => {} });
    d.add(many(25));
    expect(d.size).toBe(10);
    expect(d.dropped).toBe(15);
    expect(ids(d.queued())).toEqual(ids(many(10, 15)));
  });

  it("runs one flush at a time: a second flush joins the first", async () => {
    let release!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const post = async (_b: Packet[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => (release = r));
      inFlight--;
      return { ok: true, status: 200 };
    };
    const d = new Delivery({ post, maxQueue: 100, log: () => {} });
    d.add(many(3));
    const a = d.flush();
    const b = d.flush();
    expect(a).toBe(b);
    release();
    await a;
    expect(maxInFlight).toBe(1);
  });
});
