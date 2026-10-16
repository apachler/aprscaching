// SPDX-License-Identifier: MIT
/**
 * afsk.ts — an AFSK modulator for AX.25: Bell 202 at 1200 baud for VHF and UHF, and the 300-baud HF modem. It
 * turns an AX.25 frame into PCM, pure DSP with no audio device, for embedders that synthesise test signals or
 * drive their own audio path. APRScaching's own soundcard ports receive and transmit through Direwolf compiled
 * to WebAssembly (`@aprscaching/direwolf`); this module stays MIT so it embeds anywhere.
 *
 * Both modems: NRZI (a 0 toggles tone, a 1 holds), bits LSB-first, HDLC flags 0x7E, bit-stuffing after five
 * 1s, FCS = CRC-16/X.25. NRZI carries the data in the tone changes, not in which tone is which, so a receiver
 * that swaps mark and space (an HF radio on the other sideband) still decodes the frame.
 */

/** An AFSK modem's line rate and tone pair. */
export interface AfskModem {
  baud: number;
  /** Mark tone, Hz. */
  mark: number;
  /** Space tone, Hz. */
  space: number;
}

/** Bell 202, 1200 baud, 1200/2200 Hz: APRS on VHF and UHF FM. */
export const BELL_202: AfskModem = { baud: 1200, mark: 1200, space: 2200 };

/**
 * The HF APRS modem: 300 baud, 1600/1800 Hz (200 Hz shift, centre 1700 Hz) through an SSB radio, the tone pair
 * Direwolf's `MODEM 300` uses by default and the one the 30 m APRS channel listens for.
 */
export const HF_300: AfskModem = { baud: 300, mark: 1600, space: 1800 };

/** CRC-16/X.25 (HDLC FCS): reflected 0x1021, init 0xFFFF, final XOR 0xFFFF. */
export function crc16X25(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

/** AX.25 frame bytes → AFSK PCM (Float32, mono). `flags` = leading HDLC flags (preamble); `modem` defaults to Bell 202. */
export function modulateAfsk(
  frame: Uint8Array,
  sampleRate = 48000,
  opts: { flags?: number; amplitude?: number; modem?: AfskModem } = {},
): Float32Array {
  const { baud: BAUD, mark: MARK, space: SPACE } = opts.modem ?? BELL_202;
  const fcs = crc16X25(frame);
  const withFcs = Uint8Array.from([...frame, fcs & 0xff, (fcs >>> 8) & 0xff]);

  // data bits LSB-first, bit-stuffed (a 0 inserted after five consecutive 1s)
  const dataBits: number[] = [];
  let ones = 0;
  for (const byte of withFcs)
    for (let i = 0; i < 8; i++) {
      const bit = (byte >>> i) & 1;
      dataBits.push(bit);
      if (bit === 1) {
        if (++ones === 5) {
          dataBits.push(0);
          ones = 0;
        }
      } else ones = 0;
    }
  const flagBits = (): number[] => {
    const o: number[] = [];
    for (let i = 0; i < 8; i++) o.push((0x7e >>> i) & 1);
    return o;
  };
  const bits: number[] = [];
  for (let i = 0; i < (opts.flags ?? 48); i++) bits.push(...flagBits()); // preamble
  bits.push(...dataBits);
  for (let i = 0; i < 4; i++) bits.push(...flagBits()); // trailing flags

  const spb = sampleRate / BAUD;
  const out = new Float32Array(Math.ceil(bits.length * spb) + 1);
  const amp = opts.amplitude ?? 0.7;
  let tone = MARK,
    phase = 0,
    idx = 0;
  for (const bit of bits) {
    if (bit === 0) tone = tone === MARK ? SPACE : MARK; // NRZI: 0 toggles
    const start = Math.round(idx * spb),
      end = Math.round((idx + 1) * spb);
    const dph = (2 * Math.PI * tone) / sampleRate;
    for (let s = start; s < end; s++) {
      out[s] = amp * Math.sin(phase);
      phase += dph;
      if (phase > Math.PI) phase -= 2 * Math.PI;
    }
    idx++;
  }
  return out.subarray(0, Math.round(bits.length * spb));
}
