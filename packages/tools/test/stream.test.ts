// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeStreamDecoder, encodeVaricode } from "../src/index.js";

const SR = 8000, BAUD = 31.25;

/** Deterministic LCG noise in [-1,1] (no Math.random → reproducible). */
function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; }; }

/** Synthesise a BPSK PSK31 signal (carrier offset + timing prefix + noise). */
function modBpsk(bits: string, carrierHz: number, timingPrefix: number, noiseAmp: number): number[] {
  const sps = SR / BAUD; const out: number[] = [];
  for (let i = 0; i < timingPrefix; i++) out.push(0);
  let phase = 0;
  const emit = (ph: number) => { const start = out.length; for (let i = 0; i < sps; i++) out.push(Math.cos(2 * Math.PI * carrierHz * (start + i) / SR + ph)); };
  emit(phase);
  for (const b of bits) { if (b === "0") phase += Math.PI; emit(phase); }
  const rnd = lcg(999);
  return out.map((v) => v + noiseAmp * rnd());
}

/** Feed a signal through a StreamDecoder in fixed-size chunks (mimics AudioWorklet 128-sample frames). */
function streamChunks(signal: number[], chunk: number, mk = () => makeStreamDecoder("psk31", SR, { carrierHz: 1000, baud: BAUD })) {
  const dec = mk();
  let last = "";
  for (let i = 0; i < signal.length; i += chunk) last = dec.push(signal.slice(i, i + chunk));
  return { last, final: dec.flush() };
}

describe("makeStreamDecoder — incremental live decode (docs/28 §6)", () => {
  const preamble = "0".repeat(48);

  it("decodes text fed in small chunks (streaming, not batch)", () => {
    const sig = modBpsk(preamble + encodeVaricode("cq de test"), 1000, 20, 0);
    const { final } = streamChunks(sig, 128);
    expect(final).toContain("cq de test");
  });

  it("survives an off-tuned carrier + timing offset + noise through the stream", () => {
    const sig = modBpsk(preamble + encodeVaricode("hello world"), 1007, 33, 0.2);
    const { final } = streamChunks(sig, 512);
    expect(final).toContain("hello world");
  });

  it("grows the decoded text as more audio arrives (push returns full text so far)", () => {
    const dec = makeStreamDecoder("psk31", SR, { carrierHz: 1000, baud: BAUD, minRedecodeMs: 1 });
    const sig = modBpsk(preamble + encodeVaricode("cq de test"), 1000, 0, 0);
    const half = Math.floor(sig.length / 2);
    const early = dec.push(sig.slice(0, half));
    const done = dec.push(sig.slice(half));
    const finalText = dec.flush();
    expect(finalText).toContain("cq de test");
    // The mid-stream read decoded strictly fewer characters than the finished read.
    expect(early.length).toBeLessThan(finalText.length);
    expect(done.length).toBeGreaterThanOrEqual(early.length);
  });

  it("reset() clears state", () => {
    const dec = makeStreamDecoder("psk31", SR, { carrierHz: 1000, baud: BAUD });
    dec.push(modBpsk(preamble + encodeVaricode("hi"), 1000, 0, 0));
    dec.flush();
    dec.reset();
    expect(dec.text()).toBe("");
  });
});
