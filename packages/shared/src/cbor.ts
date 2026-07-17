// SPDX-License-Identifier: MIT
/**
 * cbor.ts — a deterministic CBOR codec (the RFC 8949 §4.2 core-deterministic subset) for the
 * federation wire format. Signatures cover encoded bytes, so the encoding MUST be byte-deterministic
 * across every runtime (Worker, Node, Bun, browser) — hence a small, strict, zero-dependency codec
 * rather than a general-purpose library:
 *
 *   - supported values: safe integers, UTF-8 text, byte strings, arrays, maps, true/false/null
 *   - definite lengths only; map keys sorted by their encoded bytes; shortest-form length arguments
 *   - NO floats (coordinates travel as 1e-7-degree integers — see fedwire.ts), NO tags, NO
 *     indefinite lengths, NO undefined
 *   - decode() accepts ONLY canonical bytes: it re-encodes the parsed value and rejects on any byte
 *     difference, which uniformly refuses duplicate map keys, unsorted keys, and oversized length
 *     arguments — a signed payload therefore has exactly one parse
 */

/** The value model: maps carry integer or text keys (integer keys keep envelopes compact). */
export type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue>;

const MT_UINT = 0,
  MT_NINT = 1,
  MT_BYTES = 2,
  MT_TEXT = 3,
  MT_ARRAY = 4,
  MT_MAP = 5,
  MT_SIMPLE = 7;

const textEncoder = new TextEncoder();
// fatal: a signed payload with invalid UTF-8 must be rejected, not silently replaced.
// (ignoreBOM is spelled out because the workerd type defs require the full options shape.)
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;
  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  take(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }
}

/** Write a major type + shortest-form length/value argument. */
function writeHead(w: ByteWriter, major: number, arg: number): void {
  const mt = major << 5;
  if (arg < 24) w.byte(mt | arg);
  else if (arg < 0x100) {
    w.byte(mt | 24);
    w.byte(arg);
  } else if (arg < 0x10000) {
    w.byte(mt | 25);
    w.byte(arg >>> 8);
    w.byte(arg & 0xff);
  } else if (arg < 0x100000000) {
    w.byte(mt | 26);
    w.byte((arg >>> 24) & 0xff);
    w.byte((arg >>> 16) & 0xff);
    w.byte((arg >>> 8) & 0xff);
    w.byte(arg & 0xff);
  } else {
    // 8-byte argument via BigInt (safe-integer inputs only — enforced by the caller)
    w.byte(mt | 27);
    const big = BigInt(arg);
    for (let shift = 56n; shift >= 0n; shift -= 8n) w.byte(Number((big >> shift) & 0xffn));
  }
}

function encodeInto(w: ByteWriter, v: CborValue): void {
  if (v === null) {
    w.byte(0xf6);
    return;
  }
  if (v === false) {
    w.byte(0xf4);
    return;
  }
  if (v === true) {
    w.byte(0xf5);
    return;
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("cbor: only safe integers are encodable (no floats)");
    if (v >= 0) writeHead(w, MT_UINT, v);
    else writeHead(w, MT_NINT, -1 - v);
    return;
  }
  if (typeof v === "string") {
    const b = textEncoder.encode(v);
    writeHead(w, MT_TEXT, b.length);
    w.bytes(b);
    return;
  }
  if (v instanceof Uint8Array) {
    writeHead(w, MT_BYTES, v.length);
    w.bytes(v);
    return;
  }
  if (Array.isArray(v)) {
    writeHead(w, MT_ARRAY, v.length);
    for (const item of v) encodeInto(w, item);
    return;
  }
  if (v instanceof Map) {
    // core deterministic: entries ordered by the bytewise comparison of their ENCODED keys
    const entries = [...v.entries()].map(([k, val]) => {
      const kw = new ByteWriter();
      encodeInto(kw, k);
      return { keyBytes: kw.take(), val };
    });
    entries.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
    writeHead(w, MT_MAP, entries.length);
    for (const e of entries) {
      w.bytes(e.keyBytes);
      encodeInto(w, e.val);
    }
    return;
  }
  throw new Error("cbor: unsupported value type");
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Encode a value as canonical deterministic CBOR. Always freshly allocated (ArrayBuffer-backed). */
export function cborEncode(v: CborValue): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  encodeInto(w, v);
  return w.take();
}

class ByteReader {
  off = 0;
  constructor(private readonly buf: Uint8Array) {}
  get remaining(): number {
    return this.buf.length - this.off;
  }
  byte(): number {
    if (this.off >= this.buf.length) throw new Error("cbor: truncated");
    return this.buf[this.off++]!;
  }
  slice(n: number): Uint8Array<ArrayBuffer> {
    if (this.off + n > this.buf.length) throw new Error("cbor: truncated");
    const out = this.buf.slice(this.off, this.off + n); // .slice copies into a fresh ArrayBuffer
    this.off += n;
    return out;
  }
}

const MAX_NESTING = 32; // a hostile peer must not stack-overflow the decoder

function readArg(r: ByteReader, info: number): number {
  if (info < 24) return info;
  if (info === 24) return r.byte();
  if (info === 25) return (r.byte() << 8) | r.byte();
  if (info === 26) return ((r.byte() << 24) | (r.byte() << 16) | (r.byte() << 8) | r.byte()) >>> 0;
  if (info === 27) {
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(r.byte());
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor: integer exceeds the safe range");
    return Number(big);
  }
  throw new Error("cbor: indefinite lengths are not canonical");
}

function decodeItem(r: ByteReader, depth: number): CborValue {
  if (depth > MAX_NESTING) throw new Error("cbor: nesting too deep");
  const b0 = r.byte();
  const major = b0 >> 5;
  const info = b0 & 0x1f;
  switch (major) {
    case MT_UINT:
      return readArg(r, info);
    case MT_NINT: {
      const n = readArg(r, info);
      if (n > Number.MAX_SAFE_INTEGER - 1) throw new Error("cbor: integer exceeds the safe range");
      return -1 - n;
    }
    case MT_BYTES:
      return r.slice(readArg(r, info));
    case MT_TEXT:
      return textDecoder.decode(r.slice(readArg(r, info)));
    case MT_ARRAY: {
      const n = readArg(r, info);
      if (n > r.remaining) throw new Error("cbor: length exceeds input"); // pre-check foils allocation bombs
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) out.push(decodeItem(r, depth + 1));
      return out;
    }
    case MT_MAP: {
      const n = readArg(r, info);
      if (n * 2 > r.remaining) throw new Error("cbor: length exceeds input");
      const out: CborMap = new Map();
      for (let i = 0; i < n; i++) {
        const k = decodeItem(r, depth + 1);
        if (typeof k !== "number" && typeof k !== "string") throw new Error("cbor: map keys must be int or text");
        const val = decodeItem(r, depth + 1);
        out.set(k, val);
      }
      return out;
    }
    case MT_SIMPLE:
      if (b0 === 0xf4) return false;
      if (b0 === 0xf5) return true;
      if (b0 === 0xf6) return null;
      throw new Error("cbor: floats/undefined/simple values are not in the deterministic subset");
    default:
      throw new Error("cbor: tags are not in the deterministic subset"); // major 6
  }
}

/**
 * Decode canonical CBOR — and ONLY canonical CBOR. The parsed value is re-encoded and compared to
 * the input byte-for-byte, so unsorted/duplicate map keys, non-shortest length arguments, and any
 * trailing bytes are all rejected. A signed payload therefore has exactly one accepted serialization.
 */
export function cborDecode(bytes: Uint8Array): CborValue {
  const r = new ByteReader(bytes);
  const v = decodeItem(r, 0);
  if (r.off !== bytes.length) throw new Error("cbor: trailing bytes");
  if (compareBytes(cborEncode(v), bytes) !== 0) throw new Error("cbor: input is not canonical");
  return v;
}

/**
 * Convert a JSON-like value (plain objects, arrays, strings, safe integers, booleans, null,
 * Uint8Array) to the CBOR value model: objects become text-keyed Maps, `undefined` object fields are
 * dropped. Non-integer numbers throw — fractional quantities must be pre-scaled to integers (e.g.
 * coordinates as 1e-7 degrees) so the signed form stays byte-deterministic.
 */
export function toCborValue(v: unknown): CborValue {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("cbor: non-integer number (scale to an integer first)");
    return v;
  }
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(toCborValue);
  if (typeof v === "object") {
    const out: CborMap = new Map();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) out.set(k, toCborValue(val));
    }
    return out;
  }
  throw new Error("cbor: unsupported value type");
}

/** Inverse of {@link toCborValue} for text-keyed maps — CBOR maps back to plain objects. */
export function fromCborValue(v: CborValue): unknown {
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v.entries()) out[String(k)] = fromCborValue(val);
    return out;
  }
  if (Array.isArray(v)) return v.map(fromCborValue);
  return v;
}
