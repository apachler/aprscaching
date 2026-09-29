// SPDX-License-Identifier: MIT
// Every line a forwarding partner or a NET/ROM neighbour sends is attacker-controlled: the text scans
// that parse it must run in linear time, so a crafted line cannot stall the node. Each case feeds a
// long adversarial input and requires it to parse well inside a second (a quadratic scan of the same
// input takes tens of seconds), with the result a short input gives.
import { describe, it, expect } from "vitest";
import { sidFlags, sidHasCompression } from "../src/fbb-binary.js";
import { FbbSession, type FbbStore } from "../src/fbb-session.js";
import { parseFSDetailed } from "../src/forward.js";
import { decodeL3rtt } from "../src/inp3.js";
import { trimEndWhere } from "../src/trim.js";

const N = 200_000;
const enc = (s: string) => new TextEncoder().encode(s);

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

const emptyStore: FbbStore = {
  outbound: () => [],
  hasBid: () => false,
  accept: () => {},
  sent: () => {},
};

describe("FBB SID flags", () => {
  it("a SID of many '[' parses fast", () => {
    const { value, ms } = timed(() => sidFlags("[".repeat(N)));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe("");
  });

  it("a SID of many '[-' parses fast", () => {
    const { value, ms } = timed(() => sidFlags("[-".repeat(N)));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe("");
  });

  it("keeps the SID semantics: the flags after the last '-' of the first bracket that has one", () => {
    expect(sidFlags("[FBB-7.00-AB1FHM$]")).toBe("AB1FHM");
    expect(sidFlags("  [BPQ-6.0.21-B1FIHM$]  ")).toBe("B1FIHM");
    expect(sidFlags("[NOFLAGS] [X-1-bf]")).toBe("BF");
    expect(sidFlags("[A[B-c]")).toBe("C");
    expect(sidFlags("[A-]")).toBe("");
    expect(sidFlags("[A-B")).toBe("");
    expect(sidHasCompression("[FBB-7.00-B1FHM$]")).toBe(true);
    expect(sidHasCompression("[FBB-7.00-FHM$]")).toBe(false);
  });
});

describe("FBB session line handling", () => {
  it("a line of many '[' with no ']' is ignored fast while awaiting the SID", () => {
    const s = new FbbSession(emptyStore, { initiator: true });
    s.start();
    const { value, ms } = timed(() => s.feed("[".repeat(N)));
    expect(ms).toBeLessThan(1000);
    expect(value.out).toEqual([]);
  });

  it("a line of many line breaks before text is handled fast", () => {
    const s = new FbbSession(emptyStore, { initiator: true });
    s.start();
    const { value, ms } = timed(() => s.feed("\n".repeat(N) + "x"));
    expect(ms).toBeLessThan(1000);
    expect(value.out).toEqual([]);
  });

  it("still recognises a SID with trailing CR/LF", () => {
    const s = new FbbSession(emptyStore, { initiator: false });
    expect(s.feed("[PEER-1.0-F$]\r\n").out).toHaveLength(1); // the responder answers with its own SID
  });

  it("does not take a bracket pair split across a line break as a SID", () => {
    const s = new FbbSession(emptyStore, { initiator: false });
    expect(s.feed("[PEER\n-1.0-F$]x").out).toEqual([]);
  });
});

describe("FS reply parsing", () => {
  it("an FS line of many spaces then a line break parses fast", () => {
    const { value, ms } = timed(() => parseFSDetailed("FS" + " ".repeat(N) + "+\n+"));
    expect(ms).toBeLessThan(1000);
    expect(value).toEqual([]);
  });

  it("keeps the FS semantics", () => {
    const verdicts = [{ verdict: "accept" }, { verdict: "accept", offset: 512 }, { verdict: "reject" }];
    expect(parseFSDetailed("FS +!512-")).toEqual(verdicts);
    expect(parseFSDetailed("  fs\n+ !512 -  ")).toEqual(verdicts); // whitespace after FS may span lines
    expect(parseFSDetailed("FS + - =").map((v) => v.verdict)).toEqual(["accept", "reject", "defer"]);
    expect(parseFSDetailed("FX +")).toEqual([]);
  });
});

describe("NET/ROM text trimming", () => {
  it("an L3RTT alias of many NULs before text decodes fast", () => {
    const { value, ms } = timed(() => decodeL3rtt(enc(`L3RTT:1 OE8APR ${"\0".repeat(N)}x`)));
    expect(ms).toBeLessThan(1000);
    expect(value?.alias).toBe("\0".repeat(N) + "x");
  });

  it("strips trailing whitespace and NUL padding from an alias", () => {
    expect(decodeL3rtt(enc("L3RTT:7 OE8APR NODE\0\0 LEVEL3_V2.1"))).toEqual({
      seq: 7,
      origin: "OE8APR",
      alias: "NODE",
    });
  });

  it("trimEndWhere trims only the trailing run", () => {
    const ws = (c: string) => c === " " || c === "\0";
    expect(trimEndWhere("a \0b \0\0 ", ws)).toBe("a \0b");
    expect(trimEndWhere("   ", ws)).toBe("");
    expect(trimEndWhere("", ws)).toBe("");
  });
});
