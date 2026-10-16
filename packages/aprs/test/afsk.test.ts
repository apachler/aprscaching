// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  modulateAfsk,
  BELL_202,
  HF_300,
  crc16X25,
  encodeAx25,
  decodeAx25,
  decodeAprs,
  type AfskModem,
} from "../src/index.js";

/** Signal power at `freq` over `x` (Goertzel). */
function goertzel(x: Float32Array, freq: number, sampleRate: number): number {
  const k = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0,
    s2 = 0;
  for (const v of x) {
    const s0 = v + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

/** The tone of every bit slot, true for mark: the stronger of the two tones over that slot. */
function tones(pcm: Float32Array, sampleRate: number, modem: AfskModem): boolean[] {
  const spb = sampleRate / modem.baud;
  const out: boolean[] = [];
  for (let i = 0; Math.round((i + 1) * spb) <= pcm.length; i++) {
    const slot = pcm.subarray(Math.round(i * spb), Math.round((i + 1) * spb));
    out.push(goertzel(slot, modem.mark, sampleRate) > goertzel(slot, modem.space, sampleRate));
  }
  return out;
}

/** NRZI: the same tone as the slot before is a 1, a change is a 0. `before` is the tone ahead of the first slot. */
const nrzi = (t: boolean[], before = true): number[] => t.map((m, i) => (m === (i === 0 ? before : t[i - 1]) ? 1 : 0));

/**
 * The frames between HDLC flags in a bit stream: destuffed, packed LSB-first, FCS checked and stripped. A
 * reference decoder for the modulator's own output, bit-aligned by construction, so it needs no clock recovery.
 */
function deframe(bits: number[]): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let body: number[] = [];
  let ones = 0;
  for (const bit of bits) {
    if (bit === 1) {
      ones++;
      body.push(1);
      continue;
    }
    if (ones === 5) {
      ones = 0; // a stuffed 0
      continue;
    }
    if (ones === 6) {
      body.length = Math.max(0, body.length - 7); // the flag's leading 0 and six 1s
      if (body.length >= 32 && body.length % 8 === 0) {
        const bytes = new Uint8Array(body.length / 8);
        body.forEach((b, i) => (bytes[i >> 3]! |= b << (i & 7)));
        const data = bytes.subarray(0, -2);
        if (crc16X25(data) === (bytes.at(-2)! | (bytes.at(-1)! << 8))) frames.push(data);
      }
      body = [];
      ones = 0;
      continue;
    }
    ones = 0;
    body.push(0);
  }
  return frames;
}

const decode = (pcm: Float32Array, sampleRate: number, modem: AfskModem = BELL_202): Uint8Array[] =>
  deframe(nrzi(tones(pcm, sampleRate, modem)));

const FLAG = [0, 1, 1, 1, 1, 1, 1, 0];

describe("afsk — Bell-202 1200-baud modulator", () => {
  it('CRC-16/X.25 matches the known check value for "123456789"', () => {
    expect(crc16X25(new TextEncoder().encode("123456789"))).toBe(0x906e);
  });

  it("carries an AX.25 APRS frame in its mark/space tones at 48 kHz", () => {
    const frame = encodeAx25({ src: "OE8APR-9", dst: "APRS", path: ["WIDE1-1"], payload: "!4704.41N/01526.27E>test" });
    const got = decode(modulateAfsk(frame, 48000, { flags: 8 }), 48000);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(frame);
    const back = decodeAx25(got[0]!)!;
    expect(back.src).toBe("OE8APR-9");
    expect((decodeAprs(back) as { kind: string }).kind).toBe("position");
  });

  it("keeps the bit timing at 44.1 kHz (non-integer samples per bit)", () => {
    const frame = encodeAx25({ src: "DL1ABC", dst: "APRS", path: [], payload: ">hello afsk" });
    const got = decode(modulateAfsk(frame, 44100, { flags: 8 }), 44100);
    expect(got).toHaveLength(1);
    expect(decodeAx25(got[0]!)!.src).toBe("DL1ABC");
  });

  it("sends the preamble and the tail as HDLC flags, one bit slot per bit", () => {
    const frame = encodeAx25({ src: "DL1ABC", dst: "APRS", path: [], payload: ">x" });
    const pcm = modulateAfsk(frame, 48000, { flags: 10 });
    const bits = nrzi(tones(pcm, 48000, BELL_202));
    for (let f = 0; f < 10; f++) expect(bits.slice(f * 8, f * 8 + 8)).toEqual(FLAG);
    expect(bits.slice(-8)).toEqual(FLAG);
    expect(bits.length * 40).toBe(pcm.length); // 40 samples per bit at 48 kHz
  });

  it("stuffs a 0 after five 1s, so no run of six 1s appears between the flags", () => {
    // 0xFF bytes in the payload force stuffing
    const frame = encodeAx25({ src: "DL1ABC", dst: "APRS", path: [], payload: ">\xff\xff\xff" });
    const pcm = modulateAfsk(frame, 48000, { flags: 2 });
    const inner = nrzi(tones(pcm, 48000, BELL_202))
      .slice(16, -32)
      .join("");
    expect(inner).not.toContain("111111");
    expect(inner).toContain("111110");
    expect(decode(pcm, 48000)[0]).toEqual(frame);
  });

  it("holds its amplitude", () => {
    const frame = encodeAx25({ src: "DL1ABC", dst: "APRS", path: [], payload: ">x" });
    const peak = Math.max(...modulateAfsk(frame, 48000, { amplitude: 0.5 }).map(Math.abs));
    expect(peak).toBeLessThanOrEqual(0.5);
    expect(peak).toBeGreaterThan(0.49);
  });
});

describe("afsk — the 300-baud HF modem", () => {
  const frame = encodeAx25({ src: "OE8APR-6", dst: "APRS", path: [], payload: '`(_fn"Oj/]HF test=' });

  it("uses 300 baud and the 1600/1800 Hz tones", () => {
    expect(HF_300).toEqual({ baud: 300, mark: 1600, space: 1800 });
    // a bit lasts four times as long as at 1200 baud
    const at300 = modulateAfsk(frame, 48000, { flags: 1, modem: HF_300 }).length;
    const at1200 = modulateAfsk(frame, 48000, { flags: 1 }).length;
    expect(at300).toBe(at1200 * 4);
  });

  it("carries the frame at 48 kHz and at 44.1 kHz", () => {
    for (const rate of [48000, 44100]) {
      const got = decode(modulateAfsk(frame, rate, { flags: 4, modem: HF_300 }), rate, HF_300);
      expect(got).toHaveLength(1);
      expect(decodeAx25(got[0]!)!.src).toBe("OE8APR-6");
    }
  });

  it("still reads with mark and space swapped, as the other sideband hears it", () => {
    const pcm = modulateAfsk(frame, 48000, { flags: 4, modem: HF_300 });
    const swapped = tones(pcm, 48000, { baud: 300, mark: 1800, space: 1600 });
    // NRZI carries the data in the tone changes, so only the reference ahead of the first slot flips
    expect(deframe(nrzi(swapped, false))[0]).toEqual(frame);
  });
});

describe("AX.25 UI frame addresses", () => {
  it("sets the destination's C bit and clears the source's: a UI frame is a command", () => {
    const frame = encodeAx25({ src: "DL1ABC", dst: "APRS", path: [], payload: ">x" });
    expect(frame[6]! & 0x80).toBe(0x80); // destination SSID octet
    expect(frame[13]! & 0x80).toBe(0); // source SSID octet
    expect(decodeAx25(frame)?.dst).toBe("APRS");
  });
});
