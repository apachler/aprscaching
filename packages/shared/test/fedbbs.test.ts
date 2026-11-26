// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { encodeFedBbsBatch, decodeFedBbsBatch, isFedBbsCategory, FED_BBS_CATEGORY } from "../src/fedbbs.js";

const frame = (n: number, len = 20) => Uint8Array.from({ length: len }, (_, i) => (n * 31 + i * 7) & 0xff);

describe("fed-over-BBS store-and-forward envelope", () => {
  it("round-trips a batch of frames through a text-safe bulletin body", () => {
    const frames = [frame(1), frame(2, 5), frame(3, 200)];
    const bull = encodeFedBbsBatch(frames);
    expect(bull.category).toBe(FED_BBS_CATEGORY);
    expect(bull.subject).toContain("3");
    const back = decodeFedBbsBatch(bull.body);
    expect(back).not.toBeNull();
    expect(back!.frames).toHaveLength(3);
    for (let i = 0; i < frames.length; i++) expect([...back!.frames[i]!]).toEqual([...frames[i]!]);
  });

  it("the body is 7-bit clean and line-wrapped for classic FBB limits", () => {
    const bull = encodeFedBbsBatch([frame(9, 500)]);
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(bull.body)).toBe(false); // no bytes outside printable ASCII + ws
    const dataLines = bull.body.trimEnd().split("\n").slice(1);
    expect(dataLines.every((l) => l.length <= 64)).toBe(true);
  });

  it("is content-addressed: identical batches carry the SAME BID, different ones differ", () => {
    const a = encodeFedBbsBatch([frame(1), frame(2)]);
    const a2 = encodeFedBbsBatch([frame(1), frame(2)]);
    const b = encodeFedBbsBatch([frame(1), frame(3)]);
    expect(a.bid).toBe(a2.bid); // dedups mesh-wide by BID
    expect(a.bid).not.toBe(b.bid);
    expect(a.bid.startsWith("AF")).toBe(true);
    expect(decodeFedBbsBatch(a.body)!.bid).toBe(a.bid);
  });

  it("survives the whitespace a BBS inserts (re-wrapped, CR/LF, trailing spaces)", () => {
    const bull = encodeFedBbsBatch([frame(4, 300)]);
    const mangled = bull.body.replace(/\n/g, "  \r\n"); // extra spaces + CRLF around every newline
    const back = decodeFedBbsBatch(mangled);
    expect(back).not.toBeNull();
    expect(back!.frames).toHaveLength(1);
    expect([...back!.frames[0]!]).toEqual([...frame(4, 300)]);
  });

  it("rejects a non-federation body, a bad magic, and a truncated payload", () => {
    expect(decodeFedBbsBatch("Hello de OE8APR\nnot a federation bulletin")).toBeNull();
    expect(decodeFedBbsBatch("ACSFED9 1 AFxyz\nAAAA")).toBeNull(); // wrong magic/version
    const good = encodeFedBbsBatch([frame(7, 400)]).body;
    const lines = good.split("\n");
    lines.splice(3, 1); // drop a data line → BID no longer matches the payload
    expect(decodeFedBbsBatch(lines.join("\n"))).toBeNull();
  });

  it("rejects a forged BID and a count that disagrees with the frames", () => {
    const bull = encodeFedBbsBatch([frame(1), frame(2)]);
    const forgedBid = bull.body.replace(bull.bid, "AFDEADBEEF");
    expect(decodeFedBbsBatch(forgedBid)).toBeNull(); // header BID ≠ content address
    const wrongCount = bull.body.replace(/^ACSFED1 2 /, "ACSFED1 5 ");
    expect(decodeFedBbsBatch(wrongCount)).toBeNull(); // declared 5, decoded 2
  });

  it("recognizes the reserved category, case- and whitespace-insensitively", () => {
    expect(isFedBbsCategory("ACSFED")).toBe(true);
    expect(isFedBbsCategory("  acsfed ")).toBe(true);
    expect(isFedBbsCategory("ALL")).toBe(false);
    expect(isFedBbsCategory("ACSFEDX")).toBe(false);
  });

  it("refuses an empty or oversized batch on encode", () => {
    expect(() => encodeFedBbsBatch([])).toThrow(/empty/);
    expect(() => encodeFedBbsBatch(Array.from({ length: 1001 }, (_, i) => frame(i, 1)))).toThrow(/exceeds/);
  });
});
