import { describe, it, expect } from "vitest";
import { encodeAgwpe, parseAgwpe } from "../src/index.js";

describe("AGWPE frame codec (docs/27 B.1)", () => {
  it("round-trips a frame through encode → parse", () => {
    const data = new TextEncoder().encode("hello agw");
    const bytes = encodeAgwpe({ port: 1, kind: "K", pid: 0xf0, from: "OE8APR-7", to: "OE8XBM-1", data });
    const { frames, rest } = parseAgwpe(bytes);
    expect(rest.length).toBe(0);
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f.port).toBe(1); expect(f.kind).toBe("K"); expect(f.pid).toBe(0xf0);
    expect(f.from).toBe("OE8APR-7"); expect(f.to).toBe("OE8XBM-1");
    expect(new TextDecoder().decode(f.data)).toBe("hello agw");
  });

  it("parses several concatenated frames and returns trailing partial bytes", () => {
    const a = encodeAgwpe({ kind: "V", from: "A", to: "B", data: new Uint8Array([1, 2]) });
    const b = encodeAgwpe({ kind: "D", from: "C", to: "D", data: new Uint8Array([3]) });
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a); joined.set(b, a.length);
    // feed everything but the last 2 bytes → second frame is incomplete, held back as rest
    const cut = joined.slice(0, joined.length - 2);
    const r1 = parseAgwpe(cut);
    expect(r1.frames).toHaveLength(1);
    expect(r1.frames[0]!.kind).toBe("V");
    expect(r1.rest.length).toBeGreaterThan(0);
    // re-feed the full buffer → both frames
    const r2 = parseAgwpe(joined);
    expect(r2.frames.map((f) => f.kind)).toEqual(["V", "D"]);
    expect(r2.rest.length).toBe(0);
  });

  it("waits for a full header before emitting anything", () => {
    const { frames, rest } = parseAgwpe(new Uint8Array(10));
    expect(frames).toHaveLength(0);
    expect(rest.length).toBe(10);
  });
});
