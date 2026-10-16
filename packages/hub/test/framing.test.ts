// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { encodeAx25, kissCommand, kissWrap } from "@aprscaching/aprs";
import { encodeFrame } from "@aprscaching/ax25";
import { KissClientStream, frameAddresses, kissDataFrame } from "../src/framing.js";

const ui = encodeAx25({ src: "OE8APR-7", dst: "APZACH", path: ["WIDE1-1"], payload: ">hub \xc0\xdb test" });

describe("KissClientStream", () => {
  it("reassembles a frame split at every byte boundary, escapes included", () => {
    const wire = kissDataFrame(ui, 3);
    for (let cut = 1; cut < wire.length; cut++) {
      const s = new KissClientStream();
      const a = s.push(wire.subarray(0, cut));
      const b = s.push(wire.subarray(cut));
      expect([...a, ...b]).toEqual([{ port: 3, frame: ui }]);
    }
  });

  it("splits several frames in one read and keeps each one's port", () => {
    const s = new KissClientStream();
    const out = s.push(Uint8Array.from([...kissWrap(ui, 0), ...kissWrap(ui, 1), ...kissWrap(ui, 15)]));
    expect(out.map((f) => f.port)).toEqual([0, 1, 15]);
  });

  it("sets command frames and return-from-KISS aside and counts them", () => {
    const s = new KissClientStream();
    const out = s.push(
      Uint8Array.from([...kissCommand(1, 50), ...kissCommand(3, 10, 2), 0xc0, 0xff, 0xc0, ...kissWrap(ui)]),
    );
    expect(out).toEqual([{ port: 0, frame: ui }]);
    // the one-byte return-from-KISS frame carries no body and is no frame at all
    expect(s.counts.commands).toBe(2);
  });

  it("removes a valid SMACK CRC, and reads a frame whose CRC fails as data on port 8-15", () => {
    // a SMACK frame on port 0: type 0x80, the frame, CRC-16 (0x8005 reflected, init 0) little-endian
    const body = [0x80, ...ui];
    let crc = 0;
    for (const b of body) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    const good = Uint8Array.from([...body, crc & 0xff, crc >> 8]);
    const esc = (b: Uint8Array) => [...b].flatMap((x) => (x === 0xc0 ? [0xdb, 0xdc] : x === 0xdb ? [0xdb, 0xdd] : [x]));
    const s = new KissClientStream();
    expect(s.push(Uint8Array.from([0xc0, ...esc(good), 0xc0]))).toEqual([{ port: 0, frame: ui }]);
    const bad = Uint8Array.from(good);
    bad[bad.length - 1]! ^= 0xff;
    expect(s.push(Uint8Array.from([0xc0, ...esc(bad), 0xc0]))).toEqual([{ port: 8, frame: bad.subarray(1) }]);
  });

  it("drops a frame that never closes and counts the overflow", () => {
    const s = new KissClientStream(64);
    expect(s.push(Uint8Array.from([0xc0, 0x00, ...new Array(100).fill(0x41)]))).toEqual([]);
    expect(s.counts.overflows).toBe(1);
    expect(s.push(kissWrap(ui))).toEqual([{ port: 0, frame: ui }]);
  });
});

describe("frameAddresses", () => {
  it("reads a UI frame's addresses", () => {
    expect(frameAddresses(ui)).toEqual({ dst: "APZACH", src: "OE8APR-7", digis: ["WIDE1-1"] });
  });

  it("reads a connected-mode frame's addresses", () => {
    const sabm = encodeFrame({
      dst: { call: "OE8BBS", ssid: 0 },
      src: { call: "OE8APR", ssid: 2 },
      type: "SABM",
      command: true,
      pf: true,
    });
    expect(frameAddresses(sabm)).toEqual({ dst: "OE8BBS", src: "OE8APR-2", digis: [] });
  });

  it("refuses bytes that hold no valid address field", () => {
    expect(frameAddresses(new Uint8Array(10))).toBeNull();
    expect(frameAddresses(ui.subarray(0, 14))).toBeNull(); // the source address never ends
    const odd = Uint8Array.from(ui);
    odd[7] = 0x41; // an unshifted byte in the source call
    expect(frameAddresses(odd)).toBeNull();
    expect(frameAddresses(ui.subarray(0, 21))).toBeNull(); // no control byte after the last address
  });
});
