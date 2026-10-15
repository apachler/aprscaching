// SPDX-License-Identifier: MIT
// KISS parameter frames: a TNC's channel access (TXDELAY, PERSIST, SLOTTIME) set from the host.
import { describe, it, expect } from "vitest";
import {
  KISS_PERSIST,
  KISS_SLOTTIME,
  KISS_TIMING_DEFAULTS,
  KISS_TXDELAY,
  KissDecoder,
  kissCommand,
  kissTimingFrames,
} from "../src/index.js";

describe("kissCommand", () => {
  it("frames a command and its one-byte value on port 0", () => {
    expect([...kissCommand(KISS_TXDELAY, 30)]).toEqual([0xc0, 0x01, 30, 0xc0]);
    expect([...kissCommand(KISS_PERSIST, 63)]).toEqual([0xc0, 0x02, 63, 0xc0]);
    expect([...kissCommand(KISS_SLOTTIME, 10)]).toEqual([0xc0, 0x03, 10, 0xc0]);
  });

  it("puts the port in the high nibble of the type byte", () => {
    expect([...kissCommand(KISS_PERSIST, 63, 2)]).toEqual([0xc0, 0x22, 63, 0xc0]);
  });

  it("escapes a value equal to FEND or FESC", () => {
    expect([...kissCommand(KISS_TXDELAY, 0xc0)]).toEqual([0xc0, 0x01, 0xdb, 0xdc, 0xc0]);
    expect([...kissCommand(KISS_TXDELAY, 0xdb)]).toEqual([0xc0, 0x01, 0xdb, 0xdd, 0xc0]);
  });

  it("refuses a value outside 0–255, a fraction, a data command or a bad port", () => {
    for (const v of [-1, 256, 1.5, Number.NaN]) expect(() => kissCommand(KISS_TXDELAY, v)).toThrow(RangeError);
    expect(() => kissCommand(0, 1)).toThrow(RangeError);
    expect(() => kissCommand(KISS_TXDELAY, 1, 16)).toThrow(RangeError);
  });

  it("decodes back to the same command and value for every byte", () => {
    for (let v = 0; v <= 255; v++) {
      const [k] = new KissDecoder().push(kissCommand(KISS_SLOTTIME, v));
      expect(k).toEqual({ port: 0, command: KISS_SLOTTIME, frame: Uint8Array.of(v) });
    }
  });
});

describe("kissTimingFrames", () => {
  it("sends TXDELAY, PERSIST and SLOTTIME in order with the APRS defaults", () => {
    expect(KISS_TIMING_DEFAULTS).toEqual({ txDelay: 30, persist: 63, slotTime: 10 });
    const got = new KissDecoder().push(kissTimingFrames(KISS_TIMING_DEFAULTS));
    expect(got.map((k) => [k.command, ...k.frame])).toEqual([
      [KISS_TXDELAY, 30],
      [KISS_PERSIST, 63],
      [KISS_SLOTTIME, 10],
    ]);
  });
});
