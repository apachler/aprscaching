import { describe, it, expect } from "vitest";
import { encodeVaricode, decodeVaricode, psk31Demod } from "../src/index.js";

const SR = 8000, CARRIER = 1000, BAUD = 31.25; // sps = 256 (integer, clean alignment)

/** Modulate a varicode bitstream to BPSK: a reference symbol then one symbol/bit; bit 0 flips the phase. */
function modBpsk(bits: string): number[] {
  const sps = SR / BAUD;
  const out: number[] = [];
  let phase = 0;
  const emit = (ph: number) => { const start = out.length; for (let i = 0; i < sps; i++) { const t = (start + i) / SR; out.push(Math.cos(2 * Math.PI * CARRIER * t + ph)); } };
  emit(phase);                                   // reference symbol
  for (const b of bits) { if (b === "0") phase += Math.PI; emit(phase); }
  return out;
}

describe("PSK31 BPSK demod → decodeVaricode (docs/28 §6)", () => {
  it("recovers text through modulate → demod → decode", () => {
    const bits = encodeVaricode("hi ok");
    const samples = modBpsk(bits);
    const recovered = psk31Demod(samples, SR, { carrierHz: CARRIER, baud: BAUD });
    expect(decodeVaricode(recovered)).toBe("hi ok");
  });
  it("recovers a single character", () => {
    expect(decodeVaricode(psk31Demod(modBpsk(encodeVaricode("R")), SR, { carrierHz: CARRIER }))).toBe("R");
  });
});
