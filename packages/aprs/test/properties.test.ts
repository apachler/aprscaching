// SPDX-License-Identifier: MIT
// Property tests over the parsers that take radio and APRS-IS input. Every line on the air or on an IS feed
// is untrusted, so each parser must return a value (never throw) for any input, return it fast, keep its
// output fields within their physical bounds, and invert its encoder where one exists.
// FUZZ_RUNS raises the number of generated cases for a deeper local run: FUZZ_RUNS=100000 pnpm test.
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { parseTNC2 } from "../src/tnc2.js";
import { decodeAprs } from "../src/decode.js";
import { decodeMicE } from "../src/mice.js";
import { parseCompressed } from "../src/compressed.js";
import { parsePosition } from "../src/position.js";
import { encodeAprsMessage, encodeAprsPosition, encodeAprsWeather } from "../src/encode.js";
import { decodeAx25, encodeAx25, kissDecode, KissDecoder, kissStripCrc, kissWrap } from "../src/ax25.js";
import type { AprsData, ParsedFrame } from "../src/types.js";

// the packages build without Node types, so the environment is read through globalThis
const fuzzRuns = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ_RUNS;
const numRuns = Number(fuzzRuns) || 300;
const run = <T>(p: fc.IProperty<T>) => fc.assert(p, { numRuns });
// a deep run takes as long as it needs
if (fuzzRuns) vi.setConfig({ testTimeout: 600_000 });

const frame = (payload: string, dst = "APRS"): ParsedFrame => ({ src: "OE8APR", dst, path: [], payload, raw: "" });

// ---- generators ----

/** Any string, any code point: what a hostile IS client can send. */
const anyText = fc.string({ unit: "binary", maxLength: 300 });
/** The characters APRS fields are made of, so generated payloads reach deep into each decoder. */
const aprsChar = fc.constantFrom(
  ..."0123456789 ./\\_-!=@:;)>`'T#{}NSEWzhgtrpPbLlA*,",
  "\x1c",
  "\x1d",
  "\x00",
  "\x7f",
  "ÿ",
  "\u{1f4e1}",
);
const aprsText = fc.array(aprsChar, { maxLength: 120 }).map((cs) => cs.join(""));
/** Real payloads of every data type, as seeds for mutation. */
const SEEDS = [
  "!4703.50N/01524.00E-PHG2360/A=001234 home",
  "=4703.50N/01524.00E_090/005g010t068r001p002P003h55b10132",
  "@092345z4703.50N/01524.00E>123/045/A=000500 mobile",
  "/092345z/5L!!<*e7>7P[ compressed",
  "!/5L!!<*e7_ sT",
  '`(_fn"Oj/]Mic-E',
  '\'(_fn"Oj/`"4V}text',
  ";TESTOBJ  *092345z4703.50N/01524.00E-object",
  ")ITEM!4703.50N/01524.00E-",
  ":OE8APR   :hello{12",
  ":OE8APR   :ack12",
  ":BLN1     :bulletin",
  ">status text",
  "_10090556c220s004g005t077r000p000P000h50b09900",
  "T#123,1,2,3,4,5,10101010",
  `T#${"9".repeat(400)},1e999,Infinity,-1e400,4,5,1`,
];
const MICE_DSTS = ["S32U6T", "T4SQ0Z", "PPPPPP", "LLLLLL", "AAAAAA", "S32U6T-7"];
const mutated = fc
  .tuple(fc.constantFrom(...SEEDS), fc.array(fc.tuple(fc.nat(), aprsChar), { maxLength: 6 }), fc.nat(), aprsText)
  .map(([seed, edits, cut, tail]) => {
    const cs = [...seed];
    for (const [at, c] of edits) cs[at % cs.length] = c;
    return cs.slice(0, cut % (cs.length + 1)).join("") + tail;
  });
const payload = fc.oneof(anyText, aprsText, mutated);

// ---- bounds ----

const finite = (n: unknown) => n === undefined || (typeof n === "number" && Number.isFinite(n));

/** The physical bounds every decoded field must sit in, whatever the input. */
function expectInBounds(d: AprsData): void {
  const o = d as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (typeof v === "number") expect(finite(v), k).toBe(true);
  if (o.lat !== undefined) expect(Math.abs(o.lat as number)).toBeLessThanOrEqual(90);
  if (o.lon !== undefined) expect(Math.abs(o.lon as number)).toBeLessThanOrEqual(180);
  if ((o.lat === undefined) !== (o.lon === undefined)) throw new Error("a fix carries both coordinates or neither");
  if (o.course !== undefined) expect(o.course as number).toBeGreaterThanOrEqual(0);
  if (o.course !== undefined) expect(o.course as number).toBeLessThanOrEqual(360);
  if (o.speedKn !== undefined) expect(o.speedKn as number).toBeGreaterThanOrEqual(0);
  if (o.ambiguity !== undefined) expect(o.ambiguity as number).toBeGreaterThanOrEqual(0);
  if (o.windDirDeg !== undefined) expect(o.windDirDeg as number).toBeLessThanOrEqual(360);
  if (o.humidity !== undefined) expect(o.humidity as number).toBeGreaterThanOrEqual(1);
  if (o.humidity !== undefined) expect(o.humidity as number).toBeLessThanOrEqual(100);
  if (d.kind === "telemetry") {
    expect(d.analog.length).toBeLessThanOrEqual(5);
    expect(d.digital.length).toBeLessThanOrEqual(8);
    expect(d.analog.every(Number.isFinite)).toBe(true);
    if (d.seq !== undefined) expect(Number.isSafeInteger(d.seq)).toBe(true);
  }
}

// ---- properties ----

describe("parseTNC2", () => {
  it("never throws, and a parsed line splits back into the line it came from", () => {
    run(
      fc.property(
        fc.oneof(
          anyText,
          fc.tuple(aprsText, aprsText, payload).map(([a, b, p]) => `${a}>${b}:${p}`),
        ),
        (line) => {
          const f = parseTNC2(line);
          if (!f) return;
          expect(`${f.src}>${[f.dst, ...f.path].join(",")}:${f.payload}`).toBe(f.raw);
          expect(f.raw).toBe(line.trimEnd());
        },
      ),
    );
  });
});

describe("decodeAprs", () => {
  it("decodes any payload without throwing, with every field within its bounds", () => {
    run(
      fc.property(payload, fc.constantFrom("APRS", ...MICE_DSTS), (p, dst) => {
        expectInBounds(decodeAprs(frame(p, dst)));
      }),
    );
  });

  it("decodes a long payload in linear time", () => {
    run(
      fc.property(fc.constantFrom(...SEEDS), aprsChar, (seed, c) => {
        const t0 = performance.now();
        decodeAprs(frame(seed + c.repeat(20_000)));
        expect(performance.now() - t0).toBeLessThan(250);
      }),
    );
  });

  it("decodes the position it encoded, to the encoder's 0.01-minute precision", () => {
    run(
      fc.property(
        fc.double({ min: -89.999, max: 89.999, noNaN: true }),
        fc.double({ min: -179.999, max: 179.999, noNaN: true }),
        (lat, lon) => {
          const d = decodeAprs(frame(encodeAprsPosition(lat, lon, "/>", "")));
          expect(d.kind).toBe("position");
          if (d.kind !== "position") return;
          expect(Math.abs(d.lat - lat)).toBeLessThan(0.01 / 60 + 1e-6);
          expect(Math.abs(d.lon - lon)).toBeLessThan(0.01 / 60 + 1e-6);
        },
      ),
    );
  });

  it("decodes the message it encoded", () => {
    const callChar = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-");
    run(
      fc.property(
        fc.array(callChar, { minLength: 1, maxLength: 9 }).map((c) => c.join("")),
        fc.string({ unit: "grapheme-ascii", maxLength: 67 }),
        fc.option(fc.stringMatching(/^[A-Za-z0-9]{1,5}$/), { nil: undefined }),
        (to, text, msgNo) => {
          const d = decodeAprs(frame(encodeAprsMessage(to, text, msgNo)));
          expect(d.kind).toBe("message");
          if (d.kind !== "message" || d.ack || d.rej) return;
          expect(d.addressee).toBe(to);
          expect(d.msgNo).toBe(msgNo);
          const body = text
            .replace(/[\r\n\x00-\x1f\x7f]/g, "")
            .trim()
            .replace(/[|~{]/g, "");
          expect(d.text).toBe(body);
        },
      ),
    );
  });

  it("decodes the weather it encoded, within the wire units' rounding", () => {
    run(
      fc.property(
        fc.integer({ min: 0, max: 360 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: -40, max: 50 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 900, max: 1080 }),
        (dir, kn, tempC, humidity, hpa) => {
          const d = decodeAprs(
            frame(encodeAprsWeather(47, 15, { windDirDeg: dir, windKn: kn, tempC, humidity, pressureHpa: hpa })),
          );
          expect(d.kind).toBe("weather");
          if (d.kind !== "weather") return;
          expect(d.windDirDeg).toBe(dir);
          expect(Math.abs(d.tempC! - tempC)).toBeLessThan(0.6);
          expect(d.humidity).toBe(humidity);
          expect(d.pressureHpa).toBeCloseTo(hpa, 5);
        },
      ),
    );
  });
});

describe("the position parsers on their own", () => {
  it("decodeMicE, parseCompressed and parsePosition never throw and stay within bounds", () => {
    run(
      fc.property(fc.oneof(fc.constantFrom(...MICE_DSTS), anyText), payload, (dst, p) => {
        const m = decodeMicE(dst, p);
        if (m) expectInBounds({ kind: "position", ...m, symbol: undefined });
        const c = parseCompressed(p);
        if (c) {
          for (const v of [c.course, c.speedKn, c.altitudeM, c.rangeKm]) expect(finite(v)).toBe(true);
          if (c.course !== undefined) expect(c.course).toBeLessThanOrEqual(360);
          if (c.speedKn !== undefined) expect(c.speedKn).toBeGreaterThanOrEqual(0);
          if (c.rangeKm !== undefined) expect(c.rangeKm).toBeGreaterThanOrEqual(0);
        }
        const u = parsePosition(p);
        if (u) expectInBounds({ kind: "position", lat: u.lat, lon: u.lon });
      }),
    );
  });
});

// ---- AX.25 + KISS ----

const call = fc
  .tuple(fc.stringMatching(/^[A-Z0-9]{1,6}$/), fc.integer({ min: 0, max: 15 }))
  .map(([c, ssid]) => (ssid ? `${c}-${ssid}` : c));
const latin1 = fc.string({ unit: fc.integer({ min: 0, max: 255 }).map((n) => String.fromCharCode(n)), maxLength: 256 });

describe("AX.25 UI frames", () => {
  it("decodeAx25 never throws on arbitrary bytes", () => {
    run(
      fc.property(fc.uint8Array({ maxLength: 400 }), (b) => {
        const f = decodeAx25(b);
        if (f) expect(f.path.length).toBeLessThanOrEqual(8);
      }),
    );
  });

  it("decodes the frame it encoded", () => {
    run(
      fc.property(
        call,
        call,
        fc.array(fc.tuple(call, fc.boolean()), { maxLength: 8 }),
        latin1,
        (src, dst, hops, text) => {
          const path = hops.map(([c, h]) => (h ? `${c}*` : c));
          const f = decodeAx25(encodeAx25({ src, dst, path, payload: text }));
          expect(f).toMatchObject({ src, dst, path, payload: text });
        },
      ),
    );
  });
});

describe("KISS", () => {
  it("unwraps the frame it wrapped", () => {
    run(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 400 }), (b) => {
        expect(kissDecode(kissWrap(b))).toEqual([{ port: 0, command: 0, frame: b }]);
      }),
    );
  });

  it("the stream decoder yields the same frames however the stream is split", () => {
    run(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 80 }), { maxLength: 6 }),
        fc.uint8Array({ maxLength: 40 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        (frames, noise, cuts) => {
          const stream = Uint8Array.from([...noise, ...frames.flatMap((f) => [...kissWrap(f)])]);
          const whole = new KissDecoder().push(stream);
          const dec = new KissDecoder();
          const parts: ReturnType<KissDecoder["push"]> = [];
          let at = 0;
          for (const c of [...cuts.map((n) => n % (stream.length + 1))].sort((a, b) => a - b)) {
            parts.push(...dec.push(stream.subarray(at, Math.max(at, c))));
            at = Math.max(at, c);
          }
          parts.push(...dec.push(stream.subarray(at)));
          expect(parts).toEqual(whole);
          // the wrapped frames come out last and in order, whatever the leading noise held
          expect(whole.slice(whole.length - frames.length).map((k) => k.frame)).toEqual(frames);
        },
      ),
    );
  });

  it("decoding arbitrary bytes never throws, stays bounded, and kissStripCrc accepts every frame", () => {
    run(
      fc.property(fc.uint8Array({ maxLength: 600 }), fc.integer({ min: 1, max: 64 }), (b, max) => {
        const dec = new KissDecoder(max);
        for (const k of dec.push(b)) {
          expect(k.frame.length).toBeLessThanOrEqual(max);
          expect(k.port).toBeLessThan(16);
          kissStripCrc(k);
        }
      }),
    );
  });
});
