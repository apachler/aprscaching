// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { crc16X25, appendAxipCrc, stripAxipCrc } from "../src/axip-crc.js";

describe("AXIP/AXUDP CRC trailer (RFC 1226)", () => {
  it("crc16X25 matches the CRC-16/X-25 check value ('123456789' -> 0x906E)", () => {
    expect(crc16X25(new TextEncoder().encode("123456789"))).toBe(0x906e);
  });

  it("appendAxipCrc appends the frame CRC low byte first", () => {
    const frame = new TextEncoder().encode("123456789");
    const out = appendAxipCrc(frame);
    expect(out.length).toBe(frame.length + 2);
    expect(out[frame.length]).toBe(0x6e);
    expect(out[frame.length + 1]).toBe(0x90);
  });

  it("stripAxipCrc validates and strips a good trailer (round-trip)", () => {
    const frame = Uint8Array.from([0x82, 0xa0, 0xa4, 0x01, 0x02, 0x03]);
    expect(Array.from(stripAxipCrc(appendAxipCrc(frame)))).toEqual(Array.from(frame));
  });

  it("stripAxipCrc leaves a bare (trailer-less) datagram unchanged", () => {
    const frame = new TextEncoder().encode("no trailer here");
    expect(Array.from(stripAxipCrc(frame))).toEqual(Array.from(frame));
  });

  it("stripAxipCrc leaves a datagram with a corrupt trailer unchanged", () => {
    const out = appendAxipCrc(new TextEncoder().encode("payload"));
    out[out.length - 1] = out[out.length - 1]! ^ 0xff;
    expect(stripAxipCrc(out).length).toBe(out.length);
  });

  it("handles runt datagrams (<= 2 bytes) without stripping", () => {
    expect(Array.from(stripAxipCrc(Uint8Array.from([1, 2])))).toEqual([1, 2]);
    expect(stripAxipCrc(new Uint8Array(0)).length).toBe(0);
  });
});
