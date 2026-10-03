// SPDX-License-Identifier: MIT
// The streaming KISS decoder: frames split across reads at any byte, behind other frames in the same read,
// keep their bytes, their escapes and their type byte.
import { describe, it, expect } from "vitest";
import { KissDecoder, kissWrap } from "../src/index.js";

const frame = (n: number) => Uint8Array.from([n, 0xc0, 0x41, 0xdb, 0x42, n]);
const wire = (frames: Uint8Array[]) => Uint8Array.from(frames.flatMap((f) => [...kissWrap(f)]));

describe("KissDecoder", () => {
  it("completes a frame split at every byte offset, behind a whole frame in the same read", () => {
    const bytes = wire([frame(1), frame(2), frame(3)]);
    for (let cut = 1; cut < bytes.length; cut++) {
      const d = new KissDecoder();
      const got = [...d.push(bytes.slice(0, cut)), ...d.push(bytes.slice(cut))];
      expect(
        got.map((k) => [...k.frame]),
        `cut at ${cut}`,
      ).toEqual([frame(1), frame(2), frame(3)].map((f) => [...f]));
    }
  });

  it("survives byte-at-a-time reads, escapes split from their FESC included", () => {
    const d = new KissDecoder();
    const got = [...wire([frame(7), frame(8)])].flatMap((b) => d.push(Uint8Array.of(b)));
    expect(got.map((k) => [...k.frame])).toEqual([[...frame(7)], [...frame(8)]]);
  });

  it("keeps the port and command nibbles of the type byte", () => {
    const d = new KissDecoder();
    const got = d.push(Uint8Array.from([0xc0, 0x80, 1, 2, 0xc0, 0xc0, 0x21, 3, 0xc0]));
    expect(got.map((k) => [k.port, k.command, [...k.frame]])).toEqual([
      [8, 0, [1, 2]],
      [2, 1, [3]],
    ]);
  });

  it("skips bytes before the first FEND and drops a frame that outgrows its bound", () => {
    const d = new KissDecoder(16);
    expect(d.push(Uint8Array.from([0x00, 0x41, 0x42]))).toEqual([]);
    expect(d.push(Uint8Array.from([0xc0, 0x00, ...new Array(40).fill(0x41)]))).toEqual([]);
    expect(d.overflows).toBe(1);
    expect(d.push(Uint8Array.from([0xc0, 0x00, 0x41, 0xc0])).map((k) => [...k.frame])).toEqual([[0x41]]);
  });

  it("forgets a partial frame on reset", () => {
    const d = new KissDecoder();
    d.push(Uint8Array.from([0xc0, 0x00, 0x41]));
    d.reset();
    expect(d.push(Uint8Array.from([0x42, 0xc0]))).toEqual([]);
  });
});
