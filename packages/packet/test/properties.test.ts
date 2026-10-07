// SPDX-License-Identifier: MIT
// Property tests over the packet-radio wire codecs: NET/ROM, INP3, AGWPE, WA8DED host mode, the FBB binary
// transfer with its LZHUF stream, and the line driver every connected-mode app runs behind. Their input
// comes from the air or a TNC socket, so each decoder returns a value or its documented error for any
// bytes, gives the same result however a stream is split into reads, and inverts its encoder.
// FUZZ_RUNS raises the number of generated cases for a deeper local run: FUZZ_RUNS=100000 pnpm test.
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  decodeNetrom,
  encodeNetrom,
  decodeNodesBroadcast,
  encodeNodesBroadcast,
  type NrPacket,
  type NodesDest,
} from "../src/netrom-wire.js";
import { decodeRif, encodeRif, decodeL3rtt, encodeL3rtt, type Rip } from "../src/inp3.js";
import { encodeAgwpe, parseAgwpe, type AgwpeFrame } from "../src/agwpe.js";
import { hostmodeData, parseHostmode, type HostmodeEvent } from "../src/hostmode.js";
import { lzhufDecodeB0, lzhufDecodeB1, lzhufEncodeB0, lzhufEncodeB1, LzhufError } from "../src/lzhuf.js";
import {
  BinaryTransferDecoder,
  decodeFbbCompressed,
  encodeBinaryTransfer,
  encodeFbbCompressed,
  type BinaryTransfer,
} from "../src/fbb-binary.js";
import { makeLineDriver, type LineApp } from "../src/link-app.js";

// the packages build without Node types, so the environment is read through globalThis
const fuzzRuns = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ_RUNS;
const numRuns = Number(fuzzRuns) || 200;
const run = <T>(p: fc.IProperty<T>) => fc.assert(p, { numRuns });
// a deep run takes as long as it needs
if (fuzzRuns) vi.setConfig({ testTimeout: 600_000 });

const addr = fc.record({ call: fc.stringMatching(/^[A-Z0-9]{1,6}$/), ssid: fc.integer({ min: 0, max: 15 }) });
const alias = fc.stringMatching(/^[A-Z0-9]{0,6}$/);
const byte = fc.integer({ min: 0, max: 255 });
const bytes = (maxLength = 400) => fc.uint8Array({ maxLength });

/** Split `b` at the given cut points and feed each read to `push`, collecting what comes out. */
function chunked<T>(b: Uint8Array, cuts: number[], push: (chunk: Uint8Array) => T[]): T[] {
  const out: T[] = [];
  let at = 0;
  for (const c of cuts.map((n) => n % (b.length + 1)).sort((x, y) => x - y)) {
    out.push(...push(b.subarray(at, Math.max(at, c))));
    at = Math.max(at, c);
  }
  out.push(...push(b.subarray(at)));
  return out;
}
const cuts = fc.array(fc.nat(), { maxLength: 8 });

/** A stream parser that returns its unconsumed tail, run read by read the way a socket client runs it. */
function streamed<T>(parse: (b: Uint8Array) => { rest: Uint8Array } & Record<string, T[] | Uint8Array>, key: string) {
  let rest: Uint8Array = new Uint8Array(0);
  return (chunk: Uint8Array): T[] => {
    const buf = new Uint8Array(rest.length + chunk.length);
    buf.set(rest);
    buf.set(chunk, rest.length);
    const r = parse(buf);
    rest = r.rest;
    return r[key] as T[];
  };
}

describe("NET/ROM", () => {
  const packet = fc.record({
    net: fc.record({ origin: addr, dest: addr, ttl: byte }),
    tp: fc.record({
      opcode: fc.integer({ min: 0, max: 15 }),
      flags: fc.constantFrom(0, 0x20, 0x40, 0x80, 0xe0),
      circuitIndex: byte,
      circuitId: byte,
      txSeq: byte,
      rxSeq: byte,
    }),
    info: bytes(236),
  });

  it("decodes the packet it encoded", () => {
    run(
      fc.property(packet, (p: NrPacket) => {
        expect(decodeNetrom(encodeNetrom(p))).toEqual(p);
      }),
    );
  });

  it("decodes the NODES broadcast it encoded, eleven destinations per frame", () => {
    const dest = fc.record({ dest: addr, alias, neighbor: addr, quality: byte });
    run(
      fc.property(alias, fc.array(dest, { maxLength: 40 }), (sender, dests: NodesDest[]) => {
        const frames = encodeNodesBroadcast(sender, dests);
        const decoded = frames.map((f) => decodeNodesBroadcast(f)!);
        expect(decoded.every((d) => d.senderAlias === sender && d.dests.length <= 11)).toBe(true);
        expect(decoded.flatMap((d) => d.dests)).toEqual(dests);
      }),
    );
  });

  it("never throws on arbitrary bytes", () => {
    run(
      fc.property(bytes(), (b) => {
        decodeNetrom(b);
        const n = decodeNodesBroadcast(b);
        if (n) expect(n.dests.length).toBe(Math.floor((b.length - 7) / 21));
      }),
    );
  });
});

describe("INP3", () => {
  const rip = fc.record(
    {
      dest: addr,
      hops: byte,
      tt: fc.integer({ min: 0, max: 0xffff }),
      alias: alias.filter((a) => a.length > 0),
      ip: fc.record({ addr: fc.tuple(byte, byte, byte, byte), bits: fc.integer({ min: 0, max: 32 }) }),
    },
    { requiredKeys: ["dest", "hops", "tt"] },
  );

  it("decodes the RIF it encoded", () => {
    run(
      fc.property(fc.array(rip, { maxLength: 12 }), (rips: Rip[]) => {
        expect(decodeRif(encodeRif(rips))).toEqual(rips);
      }),
    );
  });

  it("decodes arbitrary bytes without throwing, in one pass", () => {
    run(
      fc.property(bytes(), (b) => {
        const rips = decodeRif(Uint8Array.from([0xff, ...b]));
        expect(rips!.length).toBeLessThanOrEqual(Math.floor(b.length / 10));
      }),
    );
  });

  it("decodes the L3RTT probe it encoded", () => {
    run(
      fc.property(
        fc.nat(),
        fc.stringMatching(/^[A-Z0-9-]{1,9}$/),
        alias.filter((a) => a.length > 0),
        (seq, origin, a) => {
          expect(decodeL3rtt(encodeL3rtt({ seq, origin, alias: a }))).toEqual({ seq, origin, alias: a });
        },
      ),
    );
  });
});

describe("AGWPE", () => {
  const frame = fc.record({
    port: byte,
    kind: fc.constantFrom(..."KVDdCRXGgmyYH"),
    pid: byte,
    from: fc.stringMatching(/^[A-Z0-9-]{0,9}$/),
    to: fc.stringMatching(/^[A-Z0-9-]{0,9}$/),
    data: bytes(300),
  });

  it("parses the frames it encoded, however the stream is split into reads", () => {
    run(
      fc.property(fc.array(frame, { maxLength: 5 }), cuts, (frames: AgwpeFrame[], at) => {
        const stream = Uint8Array.from(frames.flatMap((f) => [...encodeAgwpe(f)]));
        expect(parseAgwpe(stream)).toEqual({ frames, rest: new Uint8Array(0) });
        expect(chunked(stream, at, streamed<AgwpeFrame>(parseAgwpe, "frames"))).toEqual(frames);
      }),
    );
  });

  it("never throws on arbitrary bytes and returns every byte it did not consume", () => {
    run(
      fc.property(bytes(), (b) => {
        const { frames, rest } = parseAgwpe(b);
        const used = frames.reduce((n, f) => n + 36 + f.data.length, 0);
        expect(used + rest.length).toBe(b.length);
      }),
    );
  });
});

describe("WA8DED host mode", () => {
  it("parses arbitrary bytes the same way however the stream is split into reads", () => {
    run(
      fc.property(bytes(), cuts, (b, at) => {
        const whole = parseHostmode(b);
        const parts = chunked(b, at, streamed<HostmodeEvent>(parseHostmode, "events"));
        // a read boundary may only hold back what the whole buffer would also hold back as its rest
        expect(parts).toEqual(whole.events);
      }),
    );
  });

  it("frames 1 to 256 bytes of info with a length byte that matches, and nothing for no info", () => {
    run(
      fc.property(fc.integer({ min: 0, max: 255 }), bytes(300), (chan, data) => {
        const out = hostmodeData(chan, data);
        if (!data.length) {
          expect(out.length).toBe(0);
          return;
        }
        expect(out.length).toBe(3 + out[2]! + 1);
        expect([...out.subarray(3)]).toEqual([...data.subarray(0, 256)]);
      }),
    );
  });
});

describe("LZHUF and the FBB binary transfer", () => {
  it("decompresses what it compressed (B0 and B1)", () => {
    run(
      fc.property(bytes(2000), (b) => {
        expect(lzhufDecodeB0(lzhufEncodeB0(b))).toEqual(b);
        expect(lzhufDecodeB1(lzhufEncodeB1(b))).toEqual({ data: b, crcOk: true });
      }),
    );
  });

  it("decodes arbitrary bytes to at most the declared size, or throws LzhufError and nothing else", () => {
    run(
      fc.property(bytes(64), fc.integer({ min: 0, max: 4096 }), (b, max) => {
        for (const decode of [
          (x: Uint8Array) => lzhufDecodeB0(x, max),
          (x: Uint8Array) => lzhufDecodeB1(x, max).data,
        ]) {
          try {
            expect(decode(b).length).toBeLessThanOrEqual(max);
          } catch (e) {
            expect(e).toBeInstanceOf(LzhufError);
          }
        }
      }),
    );
  });

  it("the block decoder returns the transfer it framed, however the stream is split into reads", () => {
    run(
      fc.property(bytes(255), bytes(1200), bytes(20), cuts, (header, data, noise, at) => {
        const idle = noise.filter((x) => x !== 1 && x !== 2 && x !== 4);
        const stream = Uint8Array.from([...idle, ...encodeBinaryTransfer(header, data)]);
        const dec = new BinaryTransferDecoder();
        const got = chunked(stream, at, (c) => dec.push(c));
        expect(got).toEqual([{ header, data, checksumOk: true }] satisfies BinaryTransfer[]);
      }),
    );
  });

  it("the block decoder never throws and never holds more than its ceiling", () => {
    run(
      fc.property(bytes(2000), fc.integer({ min: 1, max: 512 }), (b, max) => {
        for (const t of new BinaryTransferDecoder(max).push(b)) {
          expect(t.data.length).toBeLessThanOrEqual(max);
          expect(t.header.length).toBeLessThanOrEqual(255);
        }
      }),
    );
  });

  it("decodes the compressed message it encoded", () => {
    run(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 40 }),
        fc.string({ unit: "grapheme", maxLength: 600 }),
        (title, body) => {
          fc.pre(!title.includes("\0"));
          const [t] = new BinaryTransferDecoder().push(encodeFbbCompressed({ title, body }));
          const out = decodeFbbCompressed(t!);
          expect(out).toEqual({ title, body: body.replace(/\r(?!\n)/g, "").replace(/\r\n/g, "\n"), crcOk: true });
        },
      ),
    );
  });
});

describe("the line driver", () => {
  /** An app that records each command line it is handed. */
  const recorder = () => {
    const lines: string[] = [];
    let dropped = false;
    const app: LineApp = { greeting: () => [], handle: (l) => (lines.push(l), { lines: [] }) };
    const driver = makeLineDriver(app, { send: () => {}, disconnect: () => (dropped = true) });
    return { lines, driver, dropped: () => dropped };
  };
  const text = fc.array(
    fc.oneof(fc.string({ unit: "grapheme", maxLength: 30 }), fc.constantFrom("\r", "\n", "\r\n", "äöü€📡")),
    { maxLength: 30 },
  );

  it("hands the app the same lines however the bytes are split into frames", () => {
    run(
      fc.property(text, cuts, (parts, at) => {
        const b = new TextEncoder().encode(parts.join(""));
        const whole = recorder();
        whole.driver.onData(b);
        const split = recorder();
        chunked(b, at, (c) => (split.driver.onData(c), []));
        expect(split.lines).toEqual(whole.lines);
      }),
    );
  });

  it("keeps a session whose lines are all terminated, however much arrives in one read", () => {
    // 8 KiB and more per case, so a tenth of the runs covers it
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[ -~]{40,79}$/), { minLength: 210, maxLength: 400 }), (lines) => {
        const r = recorder();
        r.driver.onData(new TextEncoder().encode(lines.map((l) => `${l}\r`).join("")));
        expect(r.dropped()).toBe(false);
        expect(r.lines).toEqual(lines);
      }),
      { numRuns: Math.ceil(numRuns / 10) },
    );
  });

  it("still drops a session that sends 8 KiB without a line break, in one read or many", () => {
    fc.assert(
      fc.property(fc.integer({ min: 8 * 1024 + 1, max: 12 * 1024 }), cuts, (n, at) => {
        const r = recorder();
        chunked(new TextEncoder().encode(`ok\r${"x".repeat(n)}`), at, (c) => (r.driver.onData(c), []));
        expect(r.dropped()).toBe(true);
        expect(r.lines).toEqual(["ok"]);
      }),
      { numRuns: Math.ceil(numRuns / 10) },
    );
  });
});
