// SPDX-License-Identifier: MIT
/**
 * fedbbs.ts — the store-and-forward envelope that carries batched federation frames across the FBB
 * mesh. Signed fedwire frames (see fedwire.ts) are transport-agnostic: their authenticity lives in
 * their bytes, so a batch can ride an FBB bulletin exactly as it rides an HTTP sync page. A batch is
 * packed as a text-safe bulletin body — a header line plus whitespace-wrapped base64 of the CBOR
 * frame array — addressed to a reserved category. The BID is content-addressed: identical batches
 * carry the same BID, so a bulletin flooded across the mesh dedups by BID at every relay, and the
 * receiver applies each frame idempotently by its global id.
 */
import { cborEncode, cborDecode, type CborValue } from "./cbor.js";

/** Reserved BBS recipient/category that carries batched federation frames. */
export const FED_BBS_CATEGORY = "ACSFED";
/** First whitespace token of a federation bulletin body: magic + wire version. */
const FED_BBS_MAGIC = "ACSFED1";
/** A batch is bounded so a hostile body can never drive an unbounded allocation. */
const MAX_FRAMES = 1000;
/** Cap the decoded base64 region (~1 MiB of frames) — the carrier MTU bounds it in practice. */
const MAX_B64_CHARS = 1_400_000;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) m[B64_ALPHABET.charCodeAt(i)] = i;
  return m;
})();

/** Standard base64 of raw bytes — portable across Worker/Node/Bun/browser without btoa quirks. */
function b64encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
  }
  if (bytes.length - i === 1) {
    const n = bytes[i]! << 16;
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + "==";
  } else if (bytes.length - i === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + B64_ALPHABET[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Decode base64 tolerantly of any whitespace a BBS inserts; null on a bad charset/length. */
function b64decode(text: string): Uint8Array | null {
  let s = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue; // strip SP/TAB/CR/LF
    s += text[i];
  }
  s = s.replace(/=+$/, "");
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array((s.length * 3) >> 2);
  let o = 0,
    acc = 0,
    bits = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const v = code < 128 ? B64_INDEX[code]! : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/**
 * 64-bit FNV-1a over the payload → base36, so identical batches carry the SAME BID and dedup
 * mesh-wide. A dedup key, not a security digest — frame authenticity comes from the Ed25519
 * signatures inside each frame, never from this.
 */
function contentBid(payload: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < payload.length; i++) h = ((h ^ BigInt(payload[i]!)) * prime) & mask;
  return "AF" + h.toString(36).toUpperCase();
}

export interface FedBbsBatch {
  /** Content-addressed BID — the mesh dedup key. */
  bid: string;
  frames: Uint8Array[];
}
export interface FedBbsBulletin {
  /** Reserved recipient/category to address the bulletin to. */
  category: string;
  bid: string;
  subject: string;
  /** Text-safe bulletin body — 7-bit clean, whitespace-wrapped for classic FBB line limits. */
  body: string;
}

/** Pack signed fedwire frames into a text-safe FBB bulletin. Throws on an empty or oversized batch. */
export function encodeFedBbsBatch(frames: Uint8Array[]): FedBbsBulletin {
  if (!frames.length) throw new Error("fedbbs: empty batch");
  if (frames.length > MAX_FRAMES) throw new Error(`fedbbs: batch exceeds ${MAX_FRAMES} frames`);
  const payload = cborEncode(frames);
  const bid = contentBid(payload);
  const wrapped = b64encode(payload).replace(/(.{64})/g, "$1\n"); // wrap so BBS line limits don't truncate
  const body = `${FED_BBS_MAGIC} ${frames.length} ${bid}\n${wrapped}\n`;
  return { category: FED_BBS_CATEGORY, bid, subject: `federation batch (${frames.length})`, body };
}

/** Recognize a federation bulletin by its reserved category (case-insensitive). */
export function isFedBbsCategory(to: string): boolean {
  return to.trim().toUpperCase() === FED_BBS_CATEGORY;
}

/**
 * Parse a federation bulletin body back to its frames, or null if it is not one / is malformed.
 * Validates the declared frame count and re-derives the content-addressed BID, so a truncated or
 * forged body is rejected rather than half-applied.
 */
export function decodeFedBbsBatch(body: string): FedBbsBatch | null {
  const nl = body.indexOf("\n");
  if (nl < 0) return null;
  const header = body.slice(0, nl).trim().split(/\s+/);
  if (header.length !== 3 || header[0] !== FED_BBS_MAGIC) return null;
  const count = Number(header[1]);
  const bid = header[2]!;
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) return null;
  const region = body.slice(nl + 1);
  if (region.length > MAX_B64_CHARS) return null;
  const payload = b64decode(region);
  if (!payload) return null;
  if (contentBid(payload) !== bid) return null; // content-address mismatch → truncated/forged
  let decoded: CborValue;
  try {
    decoded = cborDecode(payload);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== count) return null;
  const frames: Uint8Array[] = [];
  for (const f of decoded) {
    if (!(f instanceof Uint8Array)) return null;
    frames.push(f);
  }
  return { bid, frames };
}
