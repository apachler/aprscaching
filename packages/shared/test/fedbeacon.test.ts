// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { encodeFedBeacon, decodeFedBeacon, MAX_BEACON_BYTES, FED_BEACON_MAGIC } from "../src/fedbeacon.js";

const frame = (len: number) => Uint8Array.from({ length: len }, (_, i) => (i * 7) & 0xff);

describe("beacon-tier datagram codec", () => {
  it("round-trips a frame through a single datagram payload", () => {
    const f = frame(80);
    const payload = encodeFedBeacon(f);
    expect(payload.length).toBe(FED_BEACON_MAGIC.length + 80);
    expect([...decodeFedBeacon(payload)!]).toEqual([...f]);
  });

  it("bounds the fit to one AX.25 UI frame", () => {
    expect(() => encodeFedBeacon(frame(MAX_BEACON_BYTES + 1))).toThrow(/single-datagram fit/);
    expect(encodeFedBeacon(frame(MAX_BEACON_BYTES)).length).toBe(FED_BEACON_MAGIC.length + MAX_BEACON_BYTES);
    expect(() => encodeFedBeacon(new Uint8Array(0))).toThrow(/empty/);
  });

  it("returns null for non-beacon payloads (APRS text, wrong magic, bare magic)", () => {
    expect(decodeFedBeacon(new TextEncoder().encode("!4707.35N/01526.27E-APRS comment"))).toBeNull();
    const wrong = encodeFedBeacon(frame(10));
    wrong[4] = 0x32; // version byte flipped ("ACSB2")
    expect(decodeFedBeacon(wrong)).toBeNull();
    expect(decodeFedBeacon(FED_BEACON_MAGIC.slice())).toBeNull();
  });
});
