// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { modulateAfsk1200, Afsk1200Rx, crc16X25, encodeAx25, decodeAx25, decodeAprs } from "../src/index.js";

/** Modulate an AX.25 frame to PCM, demodulate it back, return the frames recovered. */
function loopback(frame: Uint8Array, sampleRate: number): Uint8Array[] {
  const pcm = modulateAfsk1200(frame, sampleRate, { flags: 64 });
  const got: Uint8Array[] = [];
  const rx = new Afsk1200Rx(sampleRate, (f) => got.push(f));
  rx.push(pcm);
  return got;
}

describe("afsk — Bell-202 1200-baud modem", () => {
  it('CRC-16/X.25 matches the known check value for "123456789"', () => {
    expect(crc16X25(new TextEncoder().encode("123456789"))).toBe(0x906e);
  });

  it("round-trips an AX.25 APRS frame through modulate → demodulate at 48 kHz", () => {
    const frame = encodeAx25({ src: "OE8APR-9", dst: "APRS", path: ["WIDE1-1"], payload: "!4704.41N/01526.27E>test" });
    const got = loopback(frame, 48000);
    expect(got.length).toBeGreaterThanOrEqual(1);
    const back = decodeAx25(got[0]!)!;
    expect(back.src).toBe("OE8APR-9");
    expect((decodeAprs(back) as { kind: string }).kind).toBe("position");
  });

  it("also recovers the frame at 44.1 kHz (non-integer samples/bit)", () => {
    const frame = encodeAx25({ src: "DL1ABC", dst: "APRS", path: [], payload: ">hello afsk" });
    const got = loopback(frame, 44100);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(decodeAx25(got[0]!)!.src).toBe("DL1ABC");
  });

  it("rejects noise (no spurious frames from random audio)", () => {
    const noise = new Float32Array(48000);
    for (let i = 0; i < noise.length; i++)
      noise[i] = Math.sin(i * 0.7) * 0.3 + (((i * 1103515245 + 12345) & 0x7fff) / 0x7fff - 0.5);
    const got: Uint8Array[] = [];
    new Afsk1200Rx(48000, (f) => got.push(f)).push(noise);
    expect(got).toHaveLength(0);
  });

  describe("carrier detect", () => {
    /** Push PCM in 10 ms chunks and record the carrier detect after each one. */
    const trace = (pcm: Float32Array, rx: Afsk1200Rx): boolean[] => {
      const out: boolean[] = [];
      for (let i = 0; i < pcm.length; i += 480) {
        rx.push(pcm.subarray(i, i + 480));
        out.push(rx.dcd);
      }
      return out;
    };
    // a pseudo-random generator, so the noise is the same on every run
    const noise = (n: number, amp: number): Float32Array => {
      let x = 12345;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        out[i] = (x / 0x7fffffff - 0.5) * 2 * amp;
      }
      return out;
    };

    it("rises during a 1200-baud signal and falls after it ends", () => {
      const frame = encodeAx25({ src: "OE8APR-9", dst: "APRS", path: [], payload: ">carrier test" });
      const pcm = modulateAfsk1200(frame, 48000, { flags: 40 });
      const rx = new Afsk1200Rx(48000, () => {});
      const during = trace(pcm, rx);
      expect(during.slice(15).some(Boolean)).toBe(true); // after the first ~150 ms of preamble
      expect(during.at(-1)).toBe(true);
      const after = trace(new Float32Array(4800), rx); // 100 ms of silence
      expect(after.at(-1)).toBe(false);
    });

    it("stays down on noise and on silence", () => {
      const rx = new Afsk1200Rx(48000, () => {});
      expect(trace(noise(48000 * 2, 0.5), rx).filter(Boolean).length).toBe(0);
      expect(trace(new Float32Array(48000), rx).filter(Boolean).length).toBe(0);
    });

    it("stays down on a steady tone", () => {
      const tone = new Float32Array(48000);
      for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 1200 * i) / 48000);
      const rx = new Afsk1200Rx(48000, () => {});
      expect(trace(tone, rx).filter(Boolean).length).toBe(0);
    });
  });
});
