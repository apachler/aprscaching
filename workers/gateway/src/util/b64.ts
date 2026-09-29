// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Base64 codecs shared by the gateway. The url-safe alphabet (RFC 4648 §5, unpadded) carries WebAuthn
 * challenges, VAPID keys, federation keys and signatures, paging cursors and random tokens; the
 * decoders accept either alphabet, with or without padding, and throw on malformed input.
 */

/** Bytes → standard base64 (padded). Chunked so large buffers never overflow the argument list. */
export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x4000) s += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(s);
}

/** Bytes → unpadded base64url. */
export function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url or base64, padded or not → bytes. Throws on malformed input. */
export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A binary (Latin-1) string → unpadded base64url. */
export function strToB64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url or base64 → a binary (Latin-1) string. Throws on malformed input. */
export function b64urlToStr(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}
