// SPDX-License-Identifier: AGPL-3.0-or-later
// The burst scenarios of deliver.test.ts, run in a worker thread with a small, fixed stack, so a burst of a
// few ten thousand packets reaches the call-stack limit a spread append hits on every machine. The test
// bundles this file and posts the scenario's name and burst size; the worker answers with what was delivered.
import { parentPort, workerData } from "node:worker_threads";
import type { Packet } from "@aprscaching/shared";
import { Delivery } from "../src/deliver.js";
import { pkt, many } from "./burst-packets.js";

export interface BurstJob {
  scenario: "add" | "hear";
  burst: number;
  /** INGEST_BATCH_MAX, read by the bundle's stand-in for @aprscaching/shared. */
  batchMax: number;
}

export interface BurstResult {
  /** Queued right after the burst, before any flush. */
  size: number;
  dropped: number;
  /** The `ts` of every packet the gateway was handed, in order. */
  delivered: number[];
  /** Queued after the last flush. */
  left: number;
}

async function run({ scenario, burst }: BurstJob): Promise<BurstResult> {
  const delivered: number[] = [];
  const post = async (b: Packet[]) => {
    for (const p of b) delivered.push(p.ts);
    return { ok: true, status: 200 };
  };
  const d = new Delivery({ post, maxQueue: 5000, log: () => {} });
  if (scenario === "add") {
    d.add(many(burst));
    const size = d.size;
    await d.flush();
    return { size, dropped: d.dropped, delivered, left: d.size };
  }
  for (const p of many(burst)) d.hear(p);
  d.commit();
  const size = d.size;
  await d.flush();
  for (let tick = 0; tick < 3; tick++) {
    d.hear(pkt(burst + tick));
    d.commit();
    await d.flush();
  }
  return { size, dropped: d.dropped, delivered, left: d.size };
}

// a throw reaches the test as the worker's error event, a RangeError included
void run(workerData as BurstJob).then((r) => parentPort?.postMessage(r));
