// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { hostmodeCommand, hostmodeData, parseHostmode, type HostmodeEvent } from "../src/index.js";

const bytes = (...n: number[]) => Uint8Array.from(n);
const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("WA8DED host-mode codec", () => {
  it("encodes a NUL-terminated command on a channel", () => {
    expect([...hostmodeCommand(0, "I OE8APR")]).toEqual([0, 0, ...str("I OE8APR"), 0]);
  });

  it("encodes info as [chan][1][len-1][data]", () => {
    const d = Uint8Array.from(str("hi"));
    expect([...hostmodeData(2, d)]).toEqual([2, 1, 1, ...str("hi")]); // len-1 = 1 for 2 bytes
  });

  it("decodes the typed TNC responses (success / message / monitor-info / connected-info)", () => {
    const frame = new Uint8Array([
      1,
      0, // chan1 success, nothing
      0,
      1,
      ...str("OE8XBM"),
      0, // chan0 success-message "OE8XBM"
      1,
      7,
      2,
      ...str("abc"), // chan1 connected info, length byte = len-1 = 2, "abc"
    ]);
    const { events, rest } = parseHostmode(frame);
    expect(rest.length).toBe(0);
    expect(events).toEqual<HostmodeEvent[]>([
      { chan: 1, type: 0 },
      { chan: 0, type: 1, text: "OE8XBM" },
      { chan: 1, type: 7, info: Uint8Array.from(str("abc")) },
    ]);
  });

  it("decodes monitor headers (type 4 without info, type 5 with info following) and monitor info (type 6)", () => {
    const f = new Uint8Array([
      0,
      4,
      ...str("fm OE8APR to APRS ctl SABM+"),
      0, // header of a frame without info
      0,
      5,
      ...str("fm OE3PLY-7 to APRS ctl UI^ pid F0"),
      0, // header whose info follows as type 6
      0,
      6,
      1,
      ...str("OK"), // length byte = len-1 = 1
    ]);
    const { events, rest } = parseHostmode(f);
    expect(rest.length).toBe(0);
    expect(events).toEqual<HostmodeEvent[]>([
      { chan: 0, type: 4, text: "fm OE8APR to APRS ctl SABM+" },
      { chan: 0, type: 5, text: "fm OE3PLY-7 to APRS ctl UI^ pid F0" },
      { chan: 0, type: 6, info: Uint8Array.from(str("OK")) },
    ]);
  });

  it("reads a full 256-byte info block (length byte 255)", () => {
    const data = new Array(256).fill(0x41);
    const { events, rest } = parseHostmode(Uint8Array.from([0, 6, 255, ...data]));
    expect(rest.length).toBe(0);
    expect(events).toEqual([{ chan: 0, type: 6, info: Uint8Array.from(data) }]);
  });

  it("holds back a partial frame until the rest arrives", () => {
    const full = new Uint8Array([1, 7, 2, ...str("abc")]); // connected info, 3 bytes
    const r1 = parseHostmode(full.slice(0, 5)); // missing the last byte
    expect(r1.events).toHaveLength(0);
    expect(r1.rest.length).toBe(5);
    const r2 = parseHostmode(full);
    expect(r2.events).toHaveLength(1);
    expect(r2.rest.length).toBe(0);
  });

  it("waits for a NUL terminator on a message frame", () => {
    expect(parseHostmode(bytes(0, 1, 65, 66)).events).toHaveLength(0); // "AB" no terminator yet
  });
});
