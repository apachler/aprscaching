// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createDirewolfRx, createDirewolfTx, type DirewolfTxMode } from "../src/index.js";
import { concat, hex, rng, testFrame } from "./audio.js";

const RATE = 44100;
const TXDELAY = 200;
const TXTAIL = 30;

/** One frame's audio with a burst of loud noise over `ms` milliseconds in the middle of the frame itself. */
async function burst(mode: DirewolfTxMode, ms: number, seed: number): Promise<Int16Array> {
  const tx = await createDirewolfTx({ sampleRate: RATE, baud: 1200, mode, txdelayMs: TXDELAY, txtailMs: TXTAIL });
  const pcm = tx.modulate(testFrame(4, "burst"));
  const start = Math.round((RATE * TXDELAY) / 1000);
  const end = pcm.length - Math.round((RATE * TXTAIL) / 1000);
  const mid = (start + end) >> 1;
  const r = rng(seed);
  for (let i = mid; i < mid + Math.round((RATE * ms) / 1000); i++) pcm[i] = Math.round((r() * 2 - 1) * 16000);
  return concat([pcm, new Int16Array(RATE / 10)]);
}

describe("forward error correction", () => {
  for (const seed of [1, 2, 3])
    it(`FX.25 recovers a frame a noise burst destroys for plain AX.25 (seed ${seed})`, async () => {
      const rxPlain = await createDirewolfRx({ sampleRate: RATE, baud: 1200 });
      expect(rxPlain.push(await burst("ax25", 6, seed))).toEqual([]);

      const rxFx = await createDirewolfRx({ sampleRate: RATE, baud: 1200 });
      const got = rxFx.push(await burst("fx25", 6, seed));
      expect(got.map((f) => hex(f.bytes))).toEqual([hex(testFrame(4, "burst"))]);
      expect(got[0]!.fec).toBe("fx25");
      expect(got[0]!.corrected).toBeGreaterThan(0);
    });

  it("IL2P recovers the same burst", async () => {
    const rx = await createDirewolfRx({ sampleRate: RATE, baud: 1200 });
    const got = rx.push(await burst("il2p", 6, 1));
    expect(got.map((f) => hex(f.bytes))).toEqual([hex(testFrame(4, "burst"))]);
    expect(got[0]!.corrected).toBeGreaterThan(0);
  });
});
