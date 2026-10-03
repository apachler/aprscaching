// SPDX-License-Identifier: MIT
// A KISS host such as the Linux kernel's mkiss appends a SMACK or FlexNet CRC while it probes for one. The
// frames here are encoded the way mkiss sends them: SMACK low byte first, FlexNet high byte first.
import { describe, it, expect } from "vitest";
import { kissStripCrc, type KissFrame } from "../src/index.js";

const smackCrc = (bytes: number[]) => {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return [crc & 0xff, crc >> 8];
};
// the FlexNet table as the Linux mkiss driver lists it, first row
const FLEX_ROW0 = [0x0f87, 0x1e0e, 0x2c95, 0x3d1c, 0x49a3, 0x582a, 0x6ab1, 0x7b38];
const flexTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  return c ^ 0x0f87;
});
const flexCrc = (bytes: number[]) => {
  let crc = 0xffff;
  for (const b of bytes) crc = ((crc << 8) ^ flexTable[((crc >> 8) ^ b) & 0xff]!) & 0xffff;
  return [crc >> 8, crc & 0xff];
};
const frame = (type: number, data: number[]): KissFrame => ({
  port: type >> 4,
  command: type & 0x0f,
  frame: Uint8Array.from(data),
});

const AX = [0x82, 0xa0, 0xb4, 0x96, 0xa4, 0x9c, 0x60, 0x9e, 0x8a, 0x72, 0x96, 0xa4, 0x9c, 0x63, 0x03, 0xf0, 0x41];

describe("KISS CRC probes", () => {
  it("builds the FlexNet table the kernel lists", () => {
    expect(flexTable.slice(0, 8)).toEqual(FLEX_ROW0);
  });

  it("strips a valid SMACK CRC and drops a broken one", () => {
    const ok = frame(0x80, [...AX, ...smackCrc([0x80, ...AX])]);
    expect(kissStripCrc(ok)).toEqual(frame(0x00, AX));
    const bad = frame(0x80, [...AX, 0x00, 0x00]);
    expect(kissStripCrc(bad)).toBeNull();
  });

  it("strips a valid FlexNet CRC, and keeps a 0x20 frame without one as data on port 2", () => {
    const ok = frame(0x20, [...AX, ...flexCrc([0x20, ...AX])]);
    expect(kissStripCrc(ok)).toEqual(frame(0x00, AX));
    const port2 = frame(0x20, AX);
    expect(kissStripCrc(port2)).toBe(port2);
  });

  it("leaves a plain frame alone", () => {
    const plain = frame(0x00, AX);
    expect(kissStripCrc(plain)).toBe(plain);
  });
});
