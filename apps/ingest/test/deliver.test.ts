// SPDX-License-Identifier: AGPL-3.0-or-later
// The delivery queue: a backlog drains in batches the gateway accepts, a refused packet is isolated and
// dropped instead of blocking every later flush, and only an unreachable gateway keeps packets queued.
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { describe, it, expect, beforeAll } from "vitest";
import { INGEST_BATCH_MAX, Packet } from "@aprscaching/shared";
import { Delivery } from "../src/deliver.js";
import type { BurstJob, BurstResult } from "./burst.worker.js";
import { pkt, many } from "./burst-packets.js";

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

  it("drops a packet with a field past its length ceiling before it is queued", async () => {
    const gw = gateway();
    const logs: string[] = [];
    const d = new Delivery({ post: gw.post, maxQueue: 100, log: (m) => logs.push(m) });
    d.add([pkt(1), { ...pkt(2), payload: ">" + "x".repeat(600) }, { ...pkt(3), src: "X".repeat(20) }, pkt(4)]);
    expect(ids(d.queued())).toEqual([1, 4]);
    expect(d.dropped).toBe(2);
    expect(logs[0]).toMatch(/length ceiling/);
    await d.flush();
    expect(gw.batches.map(ids)).toEqual([[1, 4]]);
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

describe("Delivery after a burst", () => {
  // A spread append passes every packet as an argument on the call stack, 8 bytes each: 50 000 packets
  // need 400 KB, more than the worker's whole 384 KB stack, so the overflow is certain on every machine,
  // with a burst a sixth of the one the test runner's own ~1 MB stack would need.
  const BURST = 50_000;
  const STACK_MB = 0.375;
  let bundle = "";

  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("./burst.worker.ts", import.meta.url))],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      alias: { "@aprscaching/shared": fileURLToPath(new URL("./burst.shared-stub.ts", import.meta.url)) },
      metafile: true,
    });
    // the delivery queue alone: the schema library would cost the worker more than the burst itself
    const inputs = Object.keys(out.metafile.inputs);
    expect(inputs.filter((f) => f.includes("node_modules") || f.includes("packages/"))).toEqual([]);
    bundle = out.outputFiles[0]!.text;
  });

  const inSmallStack = (job: BurstJob) =>
    new Promise<BurstResult>((resolve, reject) => {
      const w = new Worker(bundle, {
        eval: true,
        // the bundle is plain JavaScript: none of the test runner's own flags or loaders
        execArgv: [],
        workerData: job,
        resourceLimits: { stackSizeMb: STACK_MB },
      });
      w.once("message", (r: BurstResult) => {
        resolve(r);
        void w.terminate();
      });
      w.once("error", reject);
      // an exit with no answer and no error would otherwise leave the test waiting for its timeout
      w.once("exit", (code) => reject(new Error(`burst worker exited with code ${code} before answering`)));
    });

  it("bursts only packets the real schema accepts, as the worker's stand-in assumes", () => {
    for (const p of [pkt(0), pkt(BURST - 1), pkt(BURST + 2)]) expect(Packet.safeParse(p).success).toBe(true);
  });

  it("queues a burst of any size, keeping the newest maxQueue", async () => {
    const r = await inSmallStack({ scenario: "add", burst: BURST, batchMax: INGEST_BATCH_MAX });
    expect(r.size).toBe(5000);
    expect(r.dropped).toBe(BURST - 5000);
    expect(r.delivered).toEqual(ids(many(5000, BURST - 5000)));
    expect(r.left).toBe(0);
  });

  it("keeps delivering what is heard after a burst between two commits", async () => {
    const r = await inSmallStack({ scenario: "hear", burst: BURST, batchMax: INGEST_BATCH_MAX });
    expect(r.delivered).toHaveLength(5003);
    expect(r.delivered.slice(-3)).toEqual([BURST, BURST + 1, BURST + 2]);
    expect(r.left).toBe(0);
  });

  it("holds at most twice maxQueue between two commits", () => {
    const d = new Delivery({ post: async () => ({ ok: true, status: 200 }), maxQueue: 10, log: () => {} });
    for (const p of many(1000)) d.hear(p);
    expect(d.dropped).toBeGreaterThan(970);
    d.commit();
    expect(ids(d.queued())).toEqual(ids(many(10, 990)));
    expect(d.dropped).toBe(990);
  });
});
