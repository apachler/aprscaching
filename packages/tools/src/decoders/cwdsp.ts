// SPDX-License-Identifier: MIT
/**
 * cwdsp.ts — the CW (Morse) audio FRONT-END (docs/design/28 §6 / docs/design/16 H4). `decodeMorse`/`morseFromTiming`
 * (morse.ts) are pure but need a keyed on/off envelope; this turns raw PCM audio (the Web Audio mic
 * samples) into that envelope by measuring tone energy at the CW pitch with a Goertzel single-bin detector
 * and thresholding it. Output feeds `morseFromTiming` → `decodeMorse`, so the F-5 CW decoder works on a
 * live signal, not just a hand-typed dot/dash string. Pure + unit-tested against a synthesised tone; the
 * live mic capture is a thin browser wrapper (validate-at-deploy). PSK31's BPSK demod (carrier + phase
 * recovery at 31.25 baud) is the remaining front-end seam.
 */
import type { KeyEvent } from "./morse.js";

/** Goertzel single-bin magnitude (0..~1 for a full-scale tone) of `samples` at `freq`. Pure. */
export function goertzel(samples: ArrayLike<number>, sampleRate: number, freq: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  const k = Math.round((n * freq) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = samples[i]! + coeff * s1 - s2; s2 = s1; s1 = s0; }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (Math.sqrt(Math.max(0, power)) / n) * 2;
}

export interface CwEnvelopeOpts { windowMs?: number; threshold?: number; pitchHz?: number }

/**
 * Turn PCM audio into a Morse key envelope: slide a short window, measure tone energy at `pitchHz`, and
 * threshold it (a fraction of the observed peak) to on/off runs. Returns `KeyEvent[]` for `morseFromTiming`.
 */
export function cwKeyEvents(samples: ArrayLike<number>, sampleRate: number, opts: CwEnvelopeOpts = {}): KeyEvent[] {
  const winMs = opts.windowMs ?? 8;
  const pitch = opts.pitchHz ?? 700;
  const win = Math.max(1, Math.round((sampleRate * winMs) / 1000));
  const mags: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    const slice: number[] = [];
    for (let j = 0; j < win; j++) slice.push(samples[i + j]!);
    mags.push(goertzel(slice, sampleRate, pitch));
  }
  if (!mags.length) return [];
  const peak = Math.max(...mags);
  if (peak <= 1e-6) return [];                       // silence
  const thr = (opts.threshold ?? 0.4) * peak;
  const events: KeyEvent[] = [];
  let cur = mags[0]! > thr, run = 0;
  for (const m of mags) {
    const on = m > thr;
    if (on === cur) run++;
    else { events.push({ on: cur, ms: run * winMs }); cur = on; run = 1; }
  }
  events.push({ on: cur, ms: run * winMs });
  return events;
}
