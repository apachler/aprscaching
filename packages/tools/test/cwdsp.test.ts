// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { goertzel, cwKeyEvents, morseFromTiming, decodeMorse, encodeMorse } from "../src/index.js";

const SR = 8000, PITCH = 700;

/** Synthesise PCM for a Morse string ("... --- ...") at `unit` ms/dot: tone on elements, gaps between. */
function synth(morse: string, unitMs: number): number[] {
  const spu = Math.round((SR * unitMs) / 1000);
  const out: number[] = [];
  const tone = (units: number) => { for (let i = 0; i < spu * units; i++) out.push(Math.sin((2 * Math.PI * PITCH * out.length) / SR)); };
  const gap = (units: number) => { for (let i = 0; i < spu * units; i++) out.push(0); };
  const letters = morse.trim().split(" ");
  letters.forEach((lt, li) => {
    [...lt].forEach((el, ei) => { tone(el === "." ? 1 : 3); if (ei < lt.length - 1) gap(1); });
    if (li < letters.length - 1) gap(3);
  });
  return out;
}

describe("Goertzel tone detector (docs/design/28 §6)", () => {
  it("responds to a tone at pitch and rejects silence / off-pitch", () => {
    const n = 800;
    const tone: number[] = []; for (let i = 0; i < n; i++) tone.push(Math.sin((2 * Math.PI * PITCH * i) / SR));
    const silence = new Array(n).fill(0);
    expect(goertzel(tone, SR, PITCH)).toBeGreaterThan(0.5);
    expect(goertzel(silence, SR, PITCH)).toBeLessThan(0.01);
    expect(goertzel(tone, SR, 1900)).toBeLessThan(goertzel(tone, SR, PITCH));
  });
});

describe("CW audio front-end → decodeMorse (F-5 usable on live signal)", () => {
  it("recovers text from a synthesised Morse tone end-to-end", () => {
    const samples = synth(encodeMorse("SOS"), 60);
    expect(decodeMorse(morseFromTiming(cwKeyEvents(samples, SR, { pitchHz: PITCH, windowMs: 6 })))).toBe("SOS");
  });
  it("decodes a longer word too", () => {
    const samples = synth(encodeMorse("CQ"), 50);
    expect(decodeMorse(morseFromTiming(cwKeyEvents(samples, SR, { pitchHz: PITCH, windowMs: 5 })))).toBe("CQ");
  });
  it("returns no events for silence", () => {
    expect(cwKeyEvents(new Array(4000).fill(0), SR, { pitchHz: PITCH })).toHaveLength(0);
  });
});
