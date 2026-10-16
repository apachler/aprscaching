// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  createDirewolfRx,
  createDirewolfTx,
  direwolfHasSimd,
  type DirewolfBaud,
  type DirewolfTxMode,
} from "../src/index.js";
import { addNoise, concat, hex, testFrame } from "./audio.js";

const SPEEDS: [DirewolfBaud, number][] = [
  [300, 44100],
  [1200, 44100],
  [9600, 48000],
];
const MODES: DirewolfTxMode[] = ["ax25", "fx25", "il2p"];
const FEC = { ax25: "none", fx25: "fx25", il2p: "il2p" } as const;

describe("transmit → receive", () => {
  for (const [baud, sampleRate] of SPEEDS)
    for (const mode of MODES)
      it(`${baud} bd ${mode}: every frame comes back intact`, async () => {
        const tx = await createDirewolfTx({ sampleRate, baud, mode, txdelayMs: 200, txtailMs: 30 });
        const rx = await createDirewolfRx({ sampleRate, baud });
        const frames = Array.from({ length: 6 }, (_, i) => testFrame(i, `${mode}${baud}`));
        const gap = new Int16Array(sampleRate / 10);
        const audio = addNoise(concat(frames.flatMap((f) => [tx.modulate(f), gap])), 300, baud);
        const got = rx.push(audio);
        expect(got.map((f) => hex(f.bytes))).toEqual(frames.map(hex));
        expect(new Set(got.map((f) => f.fec))).toEqual(new Set([FEC[mode]]));
      });

  it("takes float samples as well as 16-bit ones", async () => {
    const tx = await createDirewolfTx({ sampleRate: 22050, baud: 1200, mode: "ax25", txdelayMs: 200, txtailMs: 30 });
    const rx = await createDirewolfRx({ sampleRate: 22050, baud: 1200 });
    const pcm = concat([tx.modulate(testFrame(3)), new Int16Array(2205)]);
    const f32 = Float32Array.from(pcm, (s) => s / 32768);
    expect(rx.push(f32).map((f) => hex(f.bytes))).toEqual([hex(testFrame(3))]);
  });

  it("runs the plain build and the SIMD build alike", async () => {
    const tx = await createDirewolfTx({
      sampleRate: 44100,
      baud: 1200,
      mode: "fx25",
      txdelayMs: 200,
      txtailMs: 30,
      simd: false,
    });
    const audio = concat([tx.modulate(testFrame(5)), new Int16Array(4410)]);
    const plain = await createDirewolfRx({ sampleRate: 44100, baud: 1200, simd: false });
    expect(plain.push(audio).map((f) => hex(f.bytes))).toEqual([hex(testFrame(5))]);
    if (direwolfHasSimd()) {
      const simd = await createDirewolfRx({ sampleRate: 44100, baud: 1200, simd: true });
      expect(simd.push(audio).map((f) => hex(f.bytes))).toEqual([hex(testFrame(5))]);
    }
  });

  it("reports carrier while a frame is on the air and drops it on reset", async () => {
    const tx = await createDirewolfTx({ sampleRate: 44100, baud: 1200, mode: "ax25", txdelayMs: 300, txtailMs: 30 });
    const rx = await createDirewolfRx({ sampleRate: 44100, baud: 1200 });
    const audio = tx.modulate(testFrame(1));
    expect(rx.dcd).toBe(false);
    rx.push(audio.subarray(0, audio.length >> 1));
    expect(rx.dcd).toBe(true);
    rx.reset();
    expect(rx.dcd).toBe(false);
    expect(rx.push(audio.subarray(audio.length >> 1))).toEqual([]);
  });

  it("drops FX.25 and IL2P frames when told to", async () => {
    const audio: Int16Array[] = [];
    for (const mode of MODES) {
      const tx = await createDirewolfTx({ sampleRate: 44100, baud: 1200, mode, txdelayMs: 200, txtailMs: 30 });
      audio.push(tx.modulate(testFrame(MODES.indexOf(mode))), new Int16Array(4410));
    }
    const rx = await createDirewolfRx({ sampleRate: 44100, baud: 1200, fx25: false, il2p: false });
    expect(rx.push(concat(audio)).map((f) => f.fec)).toEqual(["none"]);
  });

  it("rejects what it cannot send or set up", async () => {
    await expect(createDirewolfRx({ sampleRate: 44100, baud: 2400 as DirewolfBaud })).rejects.toThrow(RangeError);
    await expect(createDirewolfRx({ sampleRate: 22050, baud: 9600 })).rejects.toThrow(/38400/);
    await expect(
      createDirewolfTx({
        sampleRate: 44100,
        baud: 1200,
        mode: "fx25",
        fx25CheckBytes: 8 as 16,
        txdelayMs: 1,
        txtailMs: 1,
      }),
    ).rejects.toThrow(/check bytes/);
    const tx = await createDirewolfTx({ sampleRate: 44100, baud: 1200, mode: "ax25", txdelayMs: 1, txtailMs: 1 });
    expect(() => tx.modulate(new Uint8Array(3))).toThrow(RangeError);
  });
});
