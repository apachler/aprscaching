// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { STAGE_MIN_CODE_BITS, codeEntropyBits, openSealedStage, sealStage } from "../src/stageseal.js";

const PAYLOAD = { lat: 47.1, lon: 15.2, clue: "under the oak", mediaUrl: null };
const FAST = 1000; // the tests use few KDF rounds; the gateway uses STAGE_KDF_ITERATIONS

describe("a sealed stage", () => {
  it("opens with its code, whatever the case and surrounding space", async () => {
    const sealed = await sealStage("04:A2:5F:1B:3C:80:90", PAYLOAD, FAST);
    expect(await openSealedStage(" 04:a2:5f:1b:3c:80:90 ", sealed)).toEqual(PAYLOAD);
  });

  it("stays shut to any other code, and to tampering", async () => {
    const sealed = await sealStage("k7m2q9x4w8", PAYLOAD, FAST);
    expect(await openSealedStage("k7m2q9x4w9", sealed)).toBeNull();
    const flipped = { ...sealed, data: (sealed.data[0] === "A" ? "B" : "A") + sealed.data.slice(1) };
    expect(await openSealedStage("k7m2q9x4w8", flipped)).toBeNull();
  });

  it("never carries the payload or the code in the clear, and salts each seal", async () => {
    const a = await sealStage("k7m2q9x4w8", PAYLOAD, FAST);
    const b = await sealStage("k7m2q9x4w8", PAYLOAD, FAST);
    const text = JSON.stringify(a);
    for (const leak of ["oak", "47.1", "k7m2"]) expect(text).not.toContain(leak);
    expect(a.salt).not.toBe(b.salt);
    expect(a.data).not.toBe(b.data);
  });
});

describe("how strong a tag code is", () => {
  it("counts a tag serial and a random code as strong enough, a word or a PIN as not", () => {
    expect(codeEntropyBits("04:A2:5F:1B:3C:80:90")).toBeGreaterThanOrEqual(STAGE_MIN_CODE_BITS);
    expect(codeEntropyBits("k7m2q9x4w8")).toBeGreaterThanOrEqual(STAGE_MIN_CODE_BITS);
    expect(codeEntropyBits("1234")).toBeLessThan(STAGE_MIN_CODE_BITS);
    expect(codeEntropyBits("oak")).toBe(0);
    expect(codeEntropyBits("aaaaaaaaaaaaaaaa")).toBe(0); // too few distinct characters
  });
});
