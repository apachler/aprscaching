// SPDX-License-Identifier: AGPL-3.0-or-later
// The packets deliver.test.ts and its burst worker build, from one place, so the schema check the test makes
// in the main thread covers exactly the packets the worker queues.
import type { Packet } from "@aprscaching/shared";

export const pkt = (i: number): Packet => ({
  src: `N0CALL-${i % 16}`,
  dst: "APRS",
  path: [],
  payload: `>${i}`,
  kind: "other",
  heardVia: "rf",
  port: "kiss-tnc",
  ts: i,
});
export const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => pkt(from + i));
