// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { encodeVaricode, decodeVaricode, psk31DemodRobust } from "../src/index.js";

const SR = 8000,
  BAUD = 31.25;

/** Deterministic LCG noise in [-1,1] (no Math.random → reproducible tests). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** Modulate BPSK with a leading timing offset + a carrier freq + additive noise. */
function modBpsk(bits: string, carrierHz: number, timingPrefix: number, noiseAmp: number): number[] {
  const sps = SR / BAUD;
  const out: number[] = [];
  for (let i = 0; i < timingPrefix; i++) out.push(0); // symbols don't start at sample 0
  let phase = 0;
  const emit = (ph: number) => {
    const start = out.length;
    for (let i = 0; i < sps; i++) {
      const t = (start + i) / SR;
      out.push(Math.cos(2 * Math.PI * carrierHz * t + ph));
    }
  };
  emit(phase);
  for (const b of bits) {
    if (b === "0") phase += Math.PI;
    emit(phase);
  }
  const rnd = lcg(12345);
  return out.map((v) => v + noiseAmp * rnd());
}

describe("robust PSK31 demod — squaring carrier recovery + AGC + timing recovery", () => {
  const preamble = "0".repeat(64); // PSK31 idle (continuous reversals)

  it("recovers text through an OFF-TUNED carrier + timing offset", () => {
    const samples = modBpsk(preamble + encodeVaricode("cq de test"), 1006, 37, 0); // carrier +6 Hz
    expect(decodeVaricode(psk31DemodRobust(samples, SR, { carrierHz: 1000, baud: BAUD }))).toContain("cq de test");
  });

  it("recovers text with additive noise (weak signal)", () => {
    const samples = modBpsk(preamble + encodeVaricode("hello"), 1000, 11, 0.2); // 0.2 RMS-ish noise
    expect(decodeVaricode(psk31DemodRobust(samples, SR, { carrierHz: 1000, baud: BAUD }))).toContain("hello");
  });
});
