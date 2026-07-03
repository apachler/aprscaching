// SPDX-License-Identifier: MIT
/**
 * afsk.ts — a Bell-202 1200-baud AFSK modem. The modulator
 * turns an AX.25 frame into PCM (also the basis for gated AFSK TX); the demodulator turns PCM back
 * into AX.25 frames via a non-coherent mark/space correlator + DPLL bit recovery + HDLC deframing
 * with an X.25 FCS check. Pure DSP — the browser supplies the audio (Web Audio); no hardware here.
 *
 * Bell 202: mark = 1200 Hz, space = 2200 Hz, 1200 baud, NRZI (a 0 toggles tone, a 1 holds), bits
 * LSB-first, HDLC flags 0x7E, bit-stuffing after five 1s, FCS = CRC-16/X.25.
 */
const MARK = 1200, SPACE = 2200, BAUD = 1200;

/** CRC-16/X.25 (HDLC FCS): reflected 0x1021, init 0xFFFF, final XOR 0xFFFF. */
export function crc16X25(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return (~crc) & 0xffff;
}

/** AX.25 frame bytes → Bell-202 PCM (Float32, mono). `flags` = leading HDLC flags (preamble). */
export function modulateAfsk1200(
  frame: Uint8Array, sampleRate = 48000, opts: { flags?: number; amplitude?: number } = {},
): Float32Array {
  const fcs = crc16X25(frame);
  const withFcs = Uint8Array.from([...frame, fcs & 0xff, (fcs >>> 8) & 0xff]);

  // data bits LSB-first, bit-stuffed (a 0 inserted after five consecutive 1s)
  const dataBits: number[] = [];
  let ones = 0;
  for (const byte of withFcs) for (let i = 0; i < 8; i++) {
    const bit = (byte >>> i) & 1;
    dataBits.push(bit);
    if (bit === 1) { if (++ones === 5) { dataBits.push(0); ones = 0; } } else ones = 0;
  }
  const flagBits = (): number[] => { const o: number[] = []; for (let i = 0; i < 8; i++) o.push((0x7e >>> i) & 1); return o; };
  const bits: number[] = [];
  for (let i = 0; i < (opts.flags ?? 48); i++) bits.push(...flagBits());     // preamble
  bits.push(...dataBits);
  for (let i = 0; i < 4; i++) bits.push(...flagBits());                       // trailing flags

  const spb = sampleRate / BAUD;
  const out = new Float32Array(Math.ceil(bits.length * spb) + 1);
  const amp = opts.amplitude ?? 0.7;
  let tone = MARK, phase = 0, idx = 0;
  for (const bit of bits) {
    if (bit === 0) tone = tone === MARK ? SPACE : MARK;                       // NRZI: 0 toggles
    const start = Math.round(idx * spb), end = Math.round((idx + 1) * spb);
    const dph = (2 * Math.PI * tone) / sampleRate;
    for (let s = start; s < end; s++) { out[s] = amp * Math.sin(phase); phase += dph; if (phase > Math.PI) phase -= 2 * Math.PI; }
    idx++;
  }
  return out.subarray(0, Math.round(bits.length * spb));
}

/** HDLC bit receiver: destuffs, finds flags, byte-aligns LSB-first, checks FCS, emits the frame. */
class Hdlc {
  private bits: number[] = [];
  private ones = 0;
  // SR-PARSE-02: a valid AX.25 frame is ≤ ~330 bytes (~2640 bits). A steady 0101 tone (a soundcard
  // IGate on noise, or crafted audio) never hits a flag or the >6-ones reset, so cap the accumulator
  // and drop a frame that grows past any legal length instead of letting `bits` grow ~1200/s forever.
  private static readonly MAX_BITS = 4096;
  constructor(private onFrame: (f: Uint8Array) => void) {}
  rx(bit: number): void {
    if (bit === 1) { this.ones++; this.bits.push(1); if (this.ones > 6) { this.bits.length = 0; this.ones = 0; } return; }
    if (this.ones === 5) { this.ones = 0; return; }                          // stuffed 0 → drop
    if (this.ones === 6) { this.ones = 0; this.bits.length = Math.max(0, this.bits.length - 7); this.finish(); this.bits.length = 0; return; } // flag
    this.ones = 0; this.bits.push(0);
    if (this.bits.length > Hdlc.MAX_BITS) this.bits.length = 0;              // over-long, no flag → not a frame
  }
  private finish(): void {
    const n = this.bits.length;
    if (n < 8 * 4 || n % 8 !== 0) return;                                    // need ≥ a few bytes, byte-aligned
    const bytes = new Uint8Array(n / 8);
    for (let i = 0; i < bytes.length; i++) { let v = 0; for (let j = 0; j < 8; j++) v |= this.bits[i * 8 + j]! << j; bytes[i] = v; }
    const data = bytes.subarray(0, bytes.length - 2);
    const fcs = bytes[bytes.length - 2]! | (bytes[bytes.length - 1]! << 8);
    if (crc16X25(data) === fcs) this.onFrame(data);
  }
}

/** Streaming Bell-202 demodulator: push PCM chunks, get AX.25 frames out. */
export class Afsk1200Rx {
  private spb: number;
  private win: number;
  private ring: Float32Array;
  private rp = 0;
  private filled = 0;
  private cm: Float32Array; private sm: Float32Array; private cs: Float32Array; private ss: Float32Array;
  private phase = 0;
  private lastTone = 1;        // per-sample detected tone (1 = mark)
  private prevBitTone = 1;     // last sampled tone (for NRZI)
  private hdlc: Hdlc;

  constructor(private sampleRate: number, onFrame: (f: Uint8Array) => void) {
    this.spb = sampleRate / BAUD;
    this.win = Math.round(this.spb);
    this.ring = new Float32Array(this.win);
    this.cm = new Float32Array(this.win); this.sm = new Float32Array(this.win);
    this.cs = new Float32Array(this.win); this.ss = new Float32Array(this.win);
    for (let n = 0; n < this.win; n++) {
      this.cm[n] = Math.cos((2 * Math.PI * MARK * n) / sampleRate); this.sm[n] = Math.sin((2 * Math.PI * MARK * n) / sampleRate);
      this.cs[n] = Math.cos((2 * Math.PI * SPACE * n) / sampleRate); this.ss[n] = Math.sin((2 * Math.PI * SPACE * n) / sampleRate);
    }
    this.hdlc = new Hdlc(onFrame);
  }

  push(samples: Float32Array): void {
    for (let k = 0; k < samples.length; k++) {
      this.ring[this.rp] = samples[k]!;
      this.rp = (this.rp + 1) % this.win;
      if (this.filled < this.win) { this.filled++; continue; }
      // non-coherent correlation of the last `win` samples against mark/space
      let im = 0, qm = 0, is = 0, qs = 0;
      for (let n = 0; n < this.win; n++) {
        const x = this.ring[(this.rp + n) % this.win]!;
        im += x * this.cm[n]!; qm += x * this.sm[n]!; is += x * this.cs[n]!; qs += x * this.ss[n]!;
      }
      const tone = (im * im + qm * qm) >= (is * is + qs * qs) ? 1 : 0;
      if (tone !== this.lastTone) this.phase = 0.5;                          // edge → resync to mid-bit
      this.lastTone = tone;
      this.phase += 1 / this.spb;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.hdlc.rx(tone === this.prevBitTone ? 1 : 0);                     // NRZI: same tone → 1
        this.prevBitTone = tone;
      }
    }
  }
}
