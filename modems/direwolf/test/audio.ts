// SPDX-License-Identifier: AGPL-3.0-or-later
// Test audio: frames, a seeded noise source, WAV in and out.
import { encodeAx25 } from "@aprscaching/aprs";

/** An APRS UI frame for test number `i`, with a path on every other one. */
export function testFrame(i: number, tag = "test"): Uint8Array {
  return encodeAx25({
    src: `OE8XXX-${(i % 15) + 1}`,
    dst: "APZDWF",
    path: i % 2 ? ["WIDE1-1", "WIDE2-1"] : [],
    payload: `!4637.02N/01418.53E-${tag} ${i} ${"x".repeat(i % 7)}`,
  });
}

/** A seeded uniform generator (mulberry32), so the noise is the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds Gaussian noise of the given RMS (in 16-bit units) in place, clamping to the sample range. */
export function addNoise(pcm: Int16Array, rms: number, seed: number): Int16Array {
  const r = rng(seed);
  for (let i = 0; i < pcm.length; i++) {
    const g = Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]! + g * rms)));
  }
  return pcm;
}

export function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A canonical 16-bit mono WAV file. */
export function toWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

/** Reads a canonical 16-bit mono WAV file (as toWav writes it). */
export function fromWav(file: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const sampleRate = v.getUint32(24, true);
  const n = v.getUint32(40, true) / 2;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = v.getInt16(44 + i * 2, true);
  return { pcm, sampleRate };
}
