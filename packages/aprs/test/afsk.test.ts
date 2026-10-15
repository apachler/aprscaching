// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  modulateAfsk,
  AfskRx,
  HF_300,
  crc16X25,
  encodeAx25,
  decodeAx25,
  decodeAprs,
  type AfskModem,
} from "../src/index.js";

/** Modulate an AX.25 frame to PCM, demodulate it back, return the frames recovered. */
function loopback(frame: Uint8Array, sampleRate: number): Uint8Array[] {
  const pcm = modulateAfsk(frame, sampleRate, { flags: 64 });
  const got: Uint8Array[] = [];
  const rx = new AfskRx(sampleRate, (f) => got.push(f));
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
    new AfskRx(48000, (f) => got.push(f)).push(noise);
    expect(got).toHaveLength(0);
  });

  describe("carrier detect", () => {
    /** Push PCM in 10 ms chunks and record the carrier detect after each one. */
    const trace = (pcm: Float32Array, rx: AfskRx): boolean[] => {
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
      const pcm = modulateAfsk(frame, 48000, { flags: 40 });
      const rx = new AfskRx(48000, () => {});
      const during = trace(pcm, rx);
      expect(during.slice(15).some(Boolean)).toBe(true); // after the first ~150 ms of preamble
      expect(during.at(-1)).toBe(true);
      const after = trace(new Float32Array(4800), rx); // 100 ms of silence
      expect(after.at(-1)).toBe(false);
    });

    it("stays down on noise and on silence", () => {
      const rx = new AfskRx(48000, () => {});
      expect(trace(noise(48000 * 2, 0.5), rx).filter(Boolean).length).toBe(0);
      expect(trace(new Float32Array(48000), rx).filter(Boolean).length).toBe(0);
    });

    it("stays down on a steady tone", () => {
      const tone = new Float32Array(48000);
      for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 1200 * i) / 48000);
      const rx = new AfskRx(48000, () => {});
      expect(trace(tone, rx).filter(Boolean).length).toBe(0);
    });
  });
});

describe("afsk — the 300-baud HF modem", () => {
  /** A pseudo-random generator, so the noise is the same on every run. */
  const lcg = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const hf = (frame: Uint8Array, sampleRate: number, modem: AfskModem = HF_300, noiseAmp = 0): Uint8Array[] => {
    const pcm = modulateAfsk(frame, sampleRate, { flags: 16, modem: HF_300 });
    if (noiseAmp) {
      const r = lcg(777);
      for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! + 2 * noiseAmp * r();
    }
    const got: Uint8Array[] = [];
    const rx = new AfskRx(sampleRate, (f) => got.push(f), modem);
    rx.push(pcm);
    rx.push(new Float32Array(sampleRate / 10));
    return got;
  };
  const frame = encodeAx25({ src: "OE8APR-6", dst: "APRS", path: [], payload: '`(_fn"Oj/]HF test=' });

  it("uses 300 baud and the 1600/1800 Hz tones", () => {
    expect(HF_300).toEqual({ baud: 300, mark: 1600, space: 1800 });
    // a bit lasts four times as long as at 1200 baud
    const at300 = modulateAfsk(frame, 48000, { flags: 1, modem: HF_300 }).length;
    const at1200 = modulateAfsk(frame, 48000, { flags: 1 }).length;
    expect(at300).toBe(at1200 * 4);
  });

  it("round-trips an AX.25 frame at 48 kHz and at 44.1 kHz", () => {
    for (const rate of [48000, 44100]) {
      const got = hf(frame, rate);
      expect(got.length).toBeGreaterThanOrEqual(1);
      expect(decodeAx25(got[0]!)!.src).toBe("OE8APR-6");
    }
  });

  it("decodes through added noise", () => {
    const got = hf(frame, 48000, HF_300, 0.35);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(decodeAx25(got[0]!)!.payload).toEqual(decodeAx25(frame)!.payload);
  });

  it("decodes with mark and space swapped, as the other sideband hears it", () => {
    const got = hf(frame, 48000, { baud: 300, mark: 1800, space: 1600 });
    expect(got.length).toBeGreaterThanOrEqual(1);
  });

  it("a 1200-baud receiver hears nothing of it, and noise alone makes no frame", () => {
    const pcm = modulateAfsk(frame, 48000, { flags: 16, modem: HF_300 });
    const at1200: Uint8Array[] = [];
    new AfskRx(48000, (f) => at1200.push(f)).push(pcm);
    expect(at1200).toHaveLength(0);
    const r = lcg(4242);
    const noise = Float32Array.from({ length: 48000 * 3 }, () => r());
    const got: Uint8Array[] = [];
    const rx = new AfskRx(48000, (f) => got.push(f), HF_300);
    rx.push(noise);
    expect(got).toHaveLength(0);
    expect(rx.dcd).toBe(false);
  });

  it("raises carrier detect during the signal", () => {
    const pcm = modulateAfsk(frame, 48000, { flags: 16, modem: HF_300 });
    const rx = new AfskRx(48000, () => {}, HF_300);
    let seen = false;
    for (let i = 0; i < pcm.length; i += 480) {
      rx.push(pcm.subarray(i, i + 480));
      seen ||= rx.dcd;
    }
    expect(seen).toBe(true);
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
