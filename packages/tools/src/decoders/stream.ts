// SPDX-License-Identifier: MIT
/**
 * stream.ts — a pure, incremental decoder for a LIVE audio stream. The batch decoders
 * (`psk31DemodRobust`, `cwKeyEvents`) take a whole PCM buffer; a live mic hands you the signal in small
 * chunks and wants text to appear as it arrives. `StreamDecoder` bridges the two: it accumulates chunks into
 * a bounded window and, at a throttled cadence, re-runs the batch decoder over the retained window and
 * returns the full text decoded so far. Keeping the whole (bounded) window and re-decoding is what lets the
 * robust demod re-lock its carrier/timing as more signal arrives — the classic weak-signal win — while the
 * cap bounds the cost of a manual-length capture. It is PURE (no Web Audio), so the browser wrapper is a
 * thin sample-tap and this — the actual logic — is unit-tested by feeding synthesised PCM in chunks.
 *
 * `push()` returns the FULL decoded text (recomputed on a re-decode tick, else the cached last value) so a
 * caller can render it wholesale without delta bookkeeping or duplication; `flush()` forces a final decode.
 */
import { psk31DemodRobust, decodeVaricode } from "./psk31.js";
import { cwKeyEvents } from "./cwdsp.js";
import { morseFromTiming, decodeMorse } from "./morse.js";

export type DecodeMode = "cw" | "psk31";

export interface StreamDecoderOpts {
  /** PSK31 centre frequency (Hz). */ carrierHz?: number;
  /** CW tone pitch (Hz). */ pitchHz?: number;
  /** Symbol rate (baud) for PSK31. */ baud?: number;
  /** Retained window cap in seconds — bounds re-decode cost; older audio is dropped once full. Default 90. */
  maxSeconds?: number;
  /** Minimum new audio (ms) before a re-decode runs, to bound CPU. Default 400. */
  minRedecodeMs?: number;
}

export interface StreamDecoder {
  /** Append a chunk of mono PCM; returns the full decoded text so far (re-decoded on a throttled tick). */
  push(chunk: ArrayLike<number>): string;
  /** Force a final re-decode of the retained window and return the full text. */
  flush(): string;
  /** The full decoded text so far (no re-decode). */
  text(): string;
  /** Clear the buffer and decoded text. */
  reset(): void;
}

/** Create a streaming decoder for `mode` at sample rate `sampleRate`. Pure — no browser APIs. */
export function makeStreamDecoder(mode: DecodeMode, sampleRate: number, opts: StreamDecoderOpts = {}): StreamDecoder {
  const cap = Math.max(1, Math.floor((opts.maxSeconds ?? 90) * sampleRate));
  const minNew = Math.max(1, Math.floor(((opts.minRedecodeMs ?? 400) * sampleRate) / 1000));

  let buf = new Float64Array(0);
  let sinceDecode = 0; // new samples appended since the last re-decode
  let out = "";

  const decodeAll = (): string => {
    if (buf.length < sampleRate / 20) return out; // < ~50 ms — nothing to decode yet
    return mode === "psk31"
      ? decodeVaricode(psk31DemodRobust(buf, sampleRate, { carrierHz: opts.carrierHz, baud: opts.baud }))
      : decodeMorse(morseFromTiming(cwKeyEvents(buf, sampleRate, { pitchHz: opts.pitchHz })));
  };

  const append = (chunk: ArrayLike<number>) => {
    const n = chunk.length;
    if (n === 0) return;
    if (buf.length + n <= cap) {
      const next = new Float64Array(buf.length + n);
      next.set(buf, 0);
      for (let i = 0; i < n; i++) next[buf.length + i] = chunk[i]!;
      buf = next;
    } else {
      // Window is full — slide: keep the newest `cap` samples so re-decode cost stays bounded.
      const keepOld = Math.max(0, cap - n);
      const next = new Float64Array(cap);
      next.set(buf.subarray(buf.length - keepOld), 0);
      const take = Math.min(n, cap);
      for (let i = 0; i < take; i++) next[keepOld + i] = chunk[n - take + i]!;
      buf = next;
    }
  };

  return {
    push(chunk) {
      append(chunk);
      sinceDecode += chunk.length;
      if (sinceDecode >= minNew) {
        out = decodeAll();
        sinceDecode = 0;
      }
      return out;
    },
    flush() {
      out = decodeAll();
      sinceDecode = 0;
      return out;
    },
    text() {
      return out;
    },
    reset() {
      buf = new Float64Array(0);
      sinceDecode = 0;
      out = "";
    },
  };
}
