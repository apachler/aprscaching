// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { hostmodeCommand, hostmodeData, parseHostmode, type HostmodeEvent } from "../src/index.js";

const bytes = (...n: number[]) => Uint8Array.from(n);
const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("WA8DED host-mode codec (docs/design/27 B.1)", () => {
  it("encodes a NUL-terminated command on a channel", () => {
    expect([...hostmodeCommand(0, "I OE8APR")]).toEqual([0, 0, ...str("I OE8APR"), 0]);
  });

  it("encodes info as [chan][1][len-1][data]", () => {
    const d = Uint8Array.from(str("hi"));
    expect([...hostmodeData(2, d)]).toEqual([2, 1, 1, ...str("hi")]); // len-1 = 1 for 2 bytes
  });

  it("decodes the typed TNC responses (success / message / monitor-info / connected-info)", () => {
    const frame = new Uint8Array([
      1, 0,                                  // chan1 success, nothing
      0, 1, ...str("OE8XBM"), 0,             // chan0 success-message "OE8XBM"
      1, 7, 3, 0, ...str("abc"),             // chan1 connected info, len=3 "abc"
    ]);
    const { events, rest } = parseHostmode(frame);
    expect(rest.length).toBe(0);
    expect(events).toEqual<HostmodeEvent[]>([
      { chan: 1, type: 0 },
      { chan: 0, type: 1, text: "OE8XBM" },
      { chan: 1, type: 7, info: Uint8Array.from(str("abc")) },
    ]);
  });

  it("decodes a monitor header+info (type 5) with the 2-byte length", () => {
    const f = new Uint8Array([3, 5, ...str("OE8APR>APRS"), 0, 2, 0, ...str("OK")]);
    const { events } = parseHostmode(f);
    expect(events[0]).toEqual({ chan: 3, type: 5, header: "OE8APR>APRS", info: Uint8Array.from(str("OK")) });
  });

  it("holds back a partial frame until the rest arrives", () => {
    const full = new Uint8Array([1, 7, 3, 0, ...str("abc")]);   // connected info len=3
    const r1 = parseHostmode(full.slice(0, 5));                 // missing the last byte
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
