// SPDX-License-Identifier: MIT
/**
 * psk31.ts — a pure PSK31 varicode codec (docs/26 F-5). BPSK31 sends each character as a varicode bit
 * pattern (every code starts + ends with '1' and contains no "00"), and characters are separated by
 * "00". This encodes/decodes that bitstream; the audio front-end (differential BPSK demod → bits) is
 * browser-side Web Audio (validate-at-deploy). Values are the standard PSK31 varicode table.
 */
const VARICODE: Record<string, string> = {
  " ": "1", "!": "111111111", "\"": "101011111", "#": "111110101", "$": "111011011",
  "%": "1011010101", "&": "1010111011", "'": "101111111", "(": "11111011", ")": "11110111",
  "*": "101101111", "+": "111011111", ",": "1110101", "-": "110101", ".": "1010111", "/": "110101111",
  "0": "10110111", "1": "10111101", "2": "11101101", "3": "11111111", "4": "101110111",
  "5": "101011011", "6": "101101011", "7": "110101101", "8": "110101011", "9": "110110111",
  ":": "11110101", ";": "110111101", "<": "111101101", "=": "1010101", ">": "111010111",
  "?": "1010101111", "@": "1010111101",
  "A": "1111101", "B": "11101011", "C": "10101101", "D": "10110101", "E": "1110111", "F": "11011011",
  "G": "11111101", "H": "101010101", "I": "1111111", "J": "111111101", "K": "101111101", "L": "11010111",
  "M": "10111011", "N": "11011101", "O": "10101011", "P": "11010101", "Q": "111011101", "R": "10101111",
  "S": "1101111", "T": "1101101", "U": "101010111", "V": "110110101", "W": "101011101", "X": "101110101",
  "Y": "101111011", "Z": "1010101101",
  "a": "1011", "b": "1011111", "c": "101111", "d": "101101", "e": "11", "f": "111101", "g": "1011011",
  "h": "101011", "i": "1101", "j": "111101011", "k": "10111111", "l": "11011", "m": "111011", "n": "1111",
  "o": "111", "p": "111111", "q": "110111111", "r": "10101", "s": "10111", "t": "101", "u": "110111",
  "v": "1111011", "w": "1101011", "x": "11011111", "y": "1011101", "z": "111010101",
  "\n": "11101111", "\r": "11101111",
};
const REV: Record<string, string> = Object.fromEntries(Object.entries(VARICODE).map(([c, v]) => [v, c]));

/** Encode text → a varicode bitstream ("00"-separated, framed by an idle "00" each side). */
export function encodeVaricode(text: string): string {
  return "00" + [...text].map((c) => VARICODE[c] ?? "").filter(Boolean).join("00") + "00";
}

/** Decode a varicode bitstream → text. Splits on "00", maps each code (unknown codes dropped). */
export function decodeVaricode(bits: string): string {
  return bits.split("00").map((code) => (code ? REV[code] ?? "" : "")).join("");
}

export interface Psk31Opts { carrierHz?: number; baud?: number }

/**
 * PSK31 differential BPSK demodulator (docs/28 §6) — the audio FRONT-END that turns PCM into the varicode
 * bitstream `decodeVaricode` consumes. Downmix to I/Q at the carrier, integrate over each 31.25-baud symbol,
 * and emit a bit per phase transition: a ~180° reversal is a binary **0**, no reversal a **1** (PSK31
 * convention). Pure + unit-tested against a synthesised signal; it assumes symbol alignment from sample 0
 * and a KNOWN carrier — live-signal **carrier + symbol-timing recovery** (a Costas/DPLL loop) is the thin
 * browser wrapper's job (validate-at-deploy). Feed the result to `decodeVaricode`.
 */
export function psk31Demod(samples: ArrayLike<number>, sampleRate: number, opts: Psk31Opts = {}): string {
  const carrier = opts.carrierHz ?? 1000;
  const sps = sampleRate / (opts.baud ?? 31.25);
  const phases: number[] = [];
  for (let s = 0; ; s++) {
    const start = Math.floor(s * sps), end = Math.floor((s + 1) * sps);
    if (end > samples.length) break;
    let I = 0, Q = 0;
    for (let i = start; i < end; i++) { const t = i / sampleRate; I += samples[i]! * Math.cos(2 * Math.PI * carrier * t); Q += samples[i]! * Math.sin(2 * Math.PI * carrier * t); }
    phases.push(Math.atan2(Q, I));
  }
  let bits = "";
  for (let i = 1; i < phases.length; i++) {
    let d = Math.abs(phases[i]! - phases[i - 1]!);
    if (d > Math.PI) d = 2 * Math.PI - d;              // wrap to [0, π]
    bits += d < Math.PI / 2 ? "1" : "0";               // small change = no reversal = 1; ~π = reversal = 0
  }
  return bits;
}

/**
 * Robust PSK31 demod for weak / off-tuned signals (docs/28 §6). Three classic stages make it immune to an
 * unknown tuning, an unknown symbol phase, and noise:
 *   1. **AGC** → unit RMS (weak-signal normalisation; makes the search scores comparable).
 *   2. **Carrier recovery by squaring.** Squaring a BPSK signal doubles the phase, so the ±180° data
 *      modulation (2·{0,π} ≡ 0) vanishes and leaves a clean tone at *2·carrier*. A fine DFT peak-search around
 *      2·nominal locates it — this is immune to the modulation, unlike a plain energy search, which locks onto
 *      a reversal sideband of an idle (all-reversals) preamble. carrier = peak / 2.
 *   3. **Symbol-timing recovery** — integrate-and-dump at the recovered carrier, pick the sampling offset that
 *      maximises baseband energy (samples at symbol centres, away from the transitions that cancel energy).
 * Then decode **differentially** on the product `cur·conj(prev)`, first de-rotating by the residual per-symbol
 * carrier error θ (estimated from the mean of the SQUARED products, which folds the {θ, θ+π} BPSK clusters
 * onto 2θ). The 180° squaring ambiguity is harmless because the decode is differential. Pure; unit-tested with
 * a carrier offset + timing offset + additive noise. Feed the result to `decodeVaricode`.
 */
export function psk31DemodRobust(samples: ArrayLike<number>, sampleRate: number, opts: Psk31Opts = {}): string {
  const nominal = opts.carrierHz ?? 1000;
  const sps = sampleRate / (opts.baud ?? 31.25);
  const N = samples.length;
  if (N < sps * 2) return "";

  // 1. AGC → unit RMS.
  let rms = 0; for (let i = 0; i < N; i++) { const v = samples[i]!; rms += v * v; }
  rms = Math.sqrt(rms / N) || 1;
  const x = new Float64Array(N); for (let i = 0; i < N; i++) x[i] = samples[i]! / rms;

  // 2. Carrier recovery by squaring: y = x² has a tone at 2·carrier with the BPSK modulation removed.
  const y = new Float64Array(N); for (let i = 0; i < N; i++) y[i] = x[i]! * x[i]!;
  const dftMag = (f: number): number => {
    const w = (2 * Math.PI * f) / sampleRate; let re = 0, im = 0;
    for (let i = 0; i < N; i++) { re += y[i]! * Math.cos(w * i); im += -y[i]! * Math.sin(w * i); }
    return Math.hypot(re, im);
  };
  let best2 = 2 * nominal, bestM = -1;
  for (let f = 2 * nominal - 40; f <= 2 * nominal + 40; f += 0.2) { const m = dftMag(f); if (m > bestM) { bestM = m; best2 = f; } }
  const carrier = best2 / 2;

  // Integrate-and-dump each symbol at the recovered carrier for a given timing offset → complex symbols. A
  // final partial window (≥ half a symbol) is kept so an offset > 0 doesn't drop the last symbol.
  const symbolsAt = (offset: number): { re: number; im: number }[] => {
    const w = (2 * Math.PI * carrier) / sampleRate;
    const out: { re: number; im: number }[] = [];
    for (let s = offset; s + sps / 2 <= N; s += sps) {
      let re = 0, im = 0;
      const a = Math.floor(s), b = Math.min(Math.floor(s + sps), N);
      for (let i = a; i < b; i++) { re += x[i]! * Math.cos(w * i); im += -x[i]! * Math.sin(w * i); }
      out.push({ re, im });
    }
    return out;
  };
  const energy = (syms: { re: number; im: number }[]): number => syms.reduce((e, s) => e + Math.hypot(s.re, s.im), 0);

  // 3. Symbol-timing search — pick the offset with max energy (symbol centres, away from transitions).
  let bestOff = 0, bestE = -1;
  for (let o = 0; o < sps; o += Math.max(1, Math.floor(sps / 64))) { const e = energy(symbolsAt(o)); if (e > bestE) { bestE = e; bestOff = o; } }
  const syms = symbolsAt(bestOff);

  // Differential product z = cur·conj(prev). Estimate residual per-symbol rotation θ from mean(z²) (folds the
  // {θ, θ+π} clusters onto 2θ), de-rotate, then decide: real(z·e^{-jθ}) > 0 ⇒ no reversal ("1") else "0".
  const z: { re: number; im: number }[] = [];
  for (let i = 1; i < syms.length; i++) {
    const p = syms[i - 1]!, c = syms[i]!;
    z.push({ re: c.re * p.re + c.im * p.im, im: c.im * p.re - c.re * p.im });
  }
  let sr = 0, si = 0; for (const zz of z) { sr += zz.re * zz.re - zz.im * zz.im; si += 2 * zz.re * zz.im; }
  const theta = Math.atan2(si, sr) / 2, ct = Math.cos(theta), st = Math.sin(theta);
  let bits = "";
  for (const zz of z) bits += (zz.re * ct + zz.im * st) > 0 ? "1" : "0";
  return bits;
}
