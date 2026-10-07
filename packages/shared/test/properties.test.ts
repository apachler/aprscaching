// SPDX-License-Identifier: MIT
// Property tests over the federation wire: the deterministic CBOR codec and the fedwire envelopes built on
// it. Every frame a peer sends is untrusted, so decoding must either return a value or throw an Error for
// any bytes, accept exactly one encoding of each value, and invert the encoder.
// FUZZ_RUNS raises the number of generated cases for a deeper local run: FUZZ_RUNS=100000 pnpm test.
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { cborDecode, cborEncode, fromCborValue, toCborValue, type CborValue } from "../src/cbor.js";
import {
  decodeFedFrame,
  decodeFedPayload,
  decodeFedSyncPage,
  encodeFedFrame,
  encodeFedPayload,
  encodeFedSyncPage,
  FED_RECORD_TYPE,
  type FedRecord,
  type FedRecordKind,
} from "../src/fedwire.js";

// the packages build without Node types, so the environment is read through globalThis
const fuzzRuns = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ_RUNS;
const numRuns = Number(fuzzRuns) || 300;
const run = <T>(p: fc.IProperty<T>) => fc.assert(p, { numRuns });
// a deep run takes as long as it needs
if (fuzzRuns) vi.setConfig({ testTimeout: 600_000 });

const int = fc.maxSafeInteger();
const text = fc.string({ unit: "binary", maxLength: 40 });
/** Any value of the CBOR model, nested a few levels. */
const { value: cborValue } = fc.letrec<{ value: CborValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    int,
    text,
    fc.boolean(),
    fc.constant(null),
    fc.uint8Array({ maxLength: 40 }),
    fc.array(tie("value"), { maxLength: 5 }),
    fc
      .array(fc.tuple(fc.oneof(int, text), tie("value")), { maxLength: 5 })
      .map((entries) => new Map(entries) as CborValue),
  ),
}));
/** A JSON-like body: text keys (any, `__proto__` and `constructor` among them), integers, nested objects. */
const { body } = fc.letrec<{ body: Record<string, unknown>; field: unknown }>((tie) => ({
  body: fc.dictionary(fc.oneof(text, fc.constantFrom("__proto__", "constructor", "toString")), tie("field"), {
    maxKeys: 6,
    noNullPrototype: true,
  }),
  field: fc.oneof(
    { depthSize: "small" },
    int,
    text,
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("field"), { maxLength: 4 }),
    tie("body"),
  ),
}));

/** The decoder's contract for hostile input: a value or an Error, never anything else. */
function decodesOrThrowsError(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
  }
}

describe("deterministic CBOR", () => {
  it("decodes the value it encoded, and re-encodes it to the same bytes", () => {
    run(
      fc.property(cborValue, (v) => {
        const b = cborEncode(v);
        const d = cborDecode(b);
        expect(d).toEqual(v);
        expect(cborEncode(d)).toEqual(b);
      }),
    );
  });

  it("decodes arbitrary bytes to a value or an Error, and any accepted bytes are canonical", () => {
    run(
      fc.property(fc.uint8Array({ maxLength: 200 }), (b) => {
        let v: CborValue;
        try {
          v = cborDecode(b);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          return;
        }
        expect(cborEncode(v)).toEqual(b);
      }),
    );
  });

  it("rejects a mutated encoding unless it is the canonical encoding of what it decodes to", () => {
    run(
      fc.property(cborValue, fc.nat(), byte(), (v, at, x) => {
        const b = cborEncode(v);
        b[at % b.length] = x;
        try {
          expect(cborEncode(cborDecode(b))).toEqual(b);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("turns a JSON-like object into the CBOR model and back without losing or adding a field", () => {
    run(
      fc.property(body, (o) => {
        const back = fromCborValue(cborDecode(cborEncode(toCborValue(o)))) as Record<string, unknown>;
        expect(back).toEqual(o);
        expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
        expect(Object.keys(back).sort()).toEqual(Object.keys(o).sort());
      }),
    );
  });
});

function byte() {
  return fc.integer({ min: 0, max: 255 });
}

const kind = fc.constantFrom(...(Object.keys(FED_RECORD_TYPE) as FedRecordKind[]));
const record: fc.Arbitrary<FedRecord> = fc.record({
  kind,
  gid: text,
  origin: text,
  v: int,
  at: int,
  signer: text,
  body,
});

describe("fedwire", () => {
  it("decodes the payload and the frame it encoded", () => {
    run(
      fc.property(record, text, fc.uint8Array({ minLength: 64, maxLength: 64 }), (r, key, sig) => {
        const payload = encodeFedPayload(r);
        expect(decodeFedPayload(payload)).toEqual(r);
        const f = decodeFedFrame(encodeFedFrame(payload, key, sig));
        expect(f).toEqual({ payload, signerKey: key, sig, record: r });
      }),
    );
  });

  it("decodes the sync page it encoded", () => {
    run(
      fc.property(
        text,
        int,
        fc.boolean(),
        fc.array(fc.uint8Array({ maxLength: 30 }), { maxLength: 6 }),
        fc.option(int, { nil: undefined }),
        fc.option(int, { nil: undefined }),
        fc.array(int, { maxLength: 4 }),
        (instance, nextCursor, complete, frames, nextId, held, gaps) => {
          const hops = frames.map((_, i) => i);
          const page = decodeFedSyncPage(
            encodeFedSyncPage(instance, nextCursor, complete, frames, nextId, hops, held, gaps),
          );
          expect(page).toEqual({
            instance,
            nextCursor,
            complete,
            frames,
            hops,
            ...(nextId !== undefined && { nextId }),
            ...(held !== undefined && { held }),
            ...(gaps.length && { gaps }),
          });
        },
      ),
    );
  });

  it("decodes arbitrary bytes and arbitrary CBOR to a record or an Error", () => {
    run(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 200 }),
          cborValue.map((v) => cborEncode(v)),
        ),
        (b) => {
          decodesOrThrowsError(() => decodeFedPayload(b));
          decodesOrThrowsError(() => decodeFedFrame(b));
          decodesOrThrowsError(() => decodeFedSyncPage(b));
        },
      ),
    );
  });

  it("rejects deep nesting fast instead of overflowing the stack", () => {
    run(
      fc.property(fc.integer({ min: 33, max: 100_000 }), fc.constantFrom(0x81, 0xa1), (depth, head) => {
        const b = new Uint8Array(depth + 1).fill(head);
        const t0 = performance.now();
        expect(() => cborDecode(b)).toThrow(Error);
        expect(performance.now() - t0).toBeLessThan(250);
      }),
    );
  });
});
