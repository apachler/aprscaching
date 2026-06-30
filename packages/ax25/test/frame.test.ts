import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame, parseAddr, addrStr, type Ax25Frame } from "../src/index.js";

const roundtrip = (f: Ax25Frame) => decodeFrame(encodeFrame(f))!;
const A = parseAddr("OE8APR-1"), B = parseAddr("OE8XBM-7");

describe("ax25 frame codec (docs/25 P0)", () => {
  it("round-trips a SABM command (P=1)", () => {
    const d = roundtrip({ dst: B, src: A, command: true, type: "SABM", pf: true });
    expect(d.type).toBe("SABM"); expect(d.command).toBe(true); expect(d.pf).toBe(true);
    expect(addrStr(d.dst)).toBe("OE8XBM-7"); expect(addrStr(d.src)).toBe("OE8APR-1");
  });

  it("round-trips a UA response (F=1)", () => {
    const d = roundtrip({ dst: A, src: B, command: false, type: "UA", pf: true });
    expect(d.type).toBe("UA"); expect(d.command).toBe(false); expect(d.pf).toBe(true);
  });

  it("round-trips an I-frame with N(S)/N(R), PID and payload", () => {
    const info = new TextEncoder().encode("hello packet");
    const d = roundtrip({ dst: B, src: A, command: true, type: "I", pf: false, ns: 3, nr: 5, pid: 0xf0, info });
    expect(d.type).toBe("I"); expect(d.ns).toBe(3); expect(d.nr).toBe(5); expect(d.pid).toBe(0xf0);
    expect(new TextDecoder().decode(d.info)).toBe("hello packet");
  });

  it("round-trips RR / RNR / REJ supervisory frames with N(R) + P/F", () => {
    for (const type of ["RR", "RNR", "REJ"] as const) {
      const d = roundtrip({ dst: B, src: A, command: true, type, pf: true, nr: 4 });
      expect(d.type).toBe(type); expect(d.nr).toBe(4); expect(d.pf).toBe(true);
    }
  });

  it("round-trips DISC/DM and a digipeated path", () => {
    expect(roundtrip({ dst: B, src: A, command: true, type: "DISC", pf: true }).type).toBe("DISC");
    const d = roundtrip({ dst: B, src: A, digis: [parseAddr("WIDE1-1")], command: true, type: "UI", pf: false, pid: 0xf0, info: new TextEncoder().encode("x") });
    expect(d.digis?.map(addrStr)).toEqual(["WIDE1-1"]);
  });

  it("rejects runt frames", () => {
    expect(decodeFrame(new Uint8Array(5))).toBeNull();
  });
});
