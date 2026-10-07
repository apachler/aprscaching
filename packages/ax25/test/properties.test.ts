// SPDX-License-Identifier: MIT
// Property tests over the AX.25 frame codec and the AXIP trailer. Frames arrive from the air and from
// AXIP/AXUDP peers, so decoding must return a frame or null for any bytes, never throw, and invert the
// encoder for every frame type in both the modulo-8 and the modulo-128 control field.
// FUZZ_RUNS raises the number of generated cases for a deeper local run: FUZZ_RUNS=100000 pnpm test.
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { decodeFrame, encodeFrame, parseAddr, addrStr, type Ax25Frame, type FrameType } from "../src/frame.js";
import { appendAxipCrc, stripAxipCrc } from "../src/axip-crc.js";

// the packages build without Node types, so the environment is read through globalThis
const fuzzRuns = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ_RUNS;
const numRuns = Number(fuzzRuns) || 300;
const run = <T>(p: fc.IProperty<T>) => fc.assert(p, { numRuns });
// a deep run takes as long as it needs
if (fuzzRuns) vi.setConfig({ testTimeout: 600_000 });

const addr = fc.record({ call: fc.stringMatching(/^[A-Z0-9]{1,6}$/), ssid: fc.integer({ min: 0, max: 15 }) });
const TYPES: FrameType[] = [
  "I",
  "RR",
  "RNR",
  "REJ",
  "SREJ",
  "SABM",
  "SABME",
  "DISC",
  "DM",
  "UA",
  "FRMR",
  "UI",
  "XID",
  "TEST",
];
const S_TYPES = new Set<FrameType>(["RR", "RNR", "REJ", "SREJ"]);

/** A well-formed frame of any type, with the fields that type carries and no others. */
const frameArb = fc
  .record({
    dst: addr,
    src: addr,
    digis: fc.array(fc.tuple(addr, fc.boolean()), { maxLength: 8 }),
    command: fc.boolean(),
    type: fc.constantFrom(...TYPES),
    pf: fc.boolean(),
    extended: fc.boolean(),
    seq: fc.tuple(fc.integer({ min: 0, max: 127 }), fc.integer({ min: 0, max: 127 })),
    pid: fc.integer({ min: 0, max: 255 }),
    info: fc.uint8Array({ minLength: 1, maxLength: 256 }),
  })
  .map(({ dst, src, digis, command, type, pf, extended, seq: [nr, ns], pid, info }) => {
    const isI = type === "I",
      isS = S_TYPES.has(type);
    const mod = extended ? 128 : 8;
    const f: Ax25Frame = { dst, src, command, type, pf };
    if (digis.length) {
      f.digis = digis.map(([a]) => a);
      f.digisRepeated = digis.map(([, h]) => h);
    }
    if (isI || isS) {
      f.nr = nr % mod;
      if (extended) f.extended = true;
    }
    if (isI) f.ns = ns % mod;
    if (isI || type === "UI") f.pid = pid;
    if (isI || type === "UI" || type === "FRMR" || type === "TEST") f.info = info;
    return f;
  });

describe("decodeFrame", () => {
  it("decodes the frame it encoded, for every type and both moduli", () => {
    run(
      fc.property(frameArb, (f) => {
        const d = decodeFrame(encodeFrame(f), f.extended ?? false);
        const strip = (x: Ax25Frame) => JSON.parse(JSON.stringify({ ...x, info: x.info && [...x.info] })) as unknown;
        expect(strip(d!)).toEqual(strip(f));
      }),
    );
  });

  it("never throws on arbitrary bytes, and a decoded frame has at most 8 digipeaters and in-range fields", () => {
    run(
      fc.property(fc.uint8Array({ maxLength: 400 }), fc.boolean(), (b, ext) => {
        const f = decodeFrame(b, ext);
        if (!f) return;
        expect(f.digis?.length ?? 0).toBeLessThanOrEqual(8);
        for (const a of [f.dst, f.src, ...(f.digis ?? [])]) {
          expect(a.ssid).toBeGreaterThanOrEqual(0);
          expect(a.ssid).toBeLessThanOrEqual(15);
        }
        const mod = f.extended ? 128 : 8;
        if (f.nr !== undefined) expect(f.nr).toBeLessThan(mod);
        if (f.ns !== undefined) expect(f.ns).toBeLessThan(mod);
        if (f.pid !== undefined) expect(Number.isInteger(f.pid)).toBe(true);
      }),
    );
  });

  it("parseAddr reads back what addrStr wrote", () => {
    run(
      fc.property(addr, (a) => {
        expect(parseAddr(addrStr(a))).toEqual(a);
      }),
    );
  });
});

describe("the AXIP CRC trailer", () => {
  it("strips the trailer it appended to a non-empty frame", () => {
    run(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 400 }), (b) => {
        expect(stripAxipCrc(appendAxipCrc(b))).toEqual(b);
      }),
    );
  });

  it("returns arbitrary bytes either whole or less exactly two trailer bytes", () => {
    run(
      fc.property(fc.uint8Array({ maxLength: 400 }), (b) => {
        const out = stripAxipCrc(b);
        expect([b.length, b.length - 2]).toContain(out.length);
      }),
    );
  });
});
