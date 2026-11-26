// SPDX-License-Identifier: AGPL-3.0-or-later
// What the burst worker's bundle gets for @aprscaching/shared: the delivery queue alone, without the schema
// library, so the worker loads in milliseconds. The batch ceiling is the real one, posted by the test; every
// packet passes, which deliver.test.ts checks against the real schema for the packets the worker queues.
import { workerData } from "node:worker_threads";

export const INGEST_BATCH_MAX: number = (workerData as { batchMax: number }).batchMax;
export const Packet = { safeParse: () => ({ success: true }) };
