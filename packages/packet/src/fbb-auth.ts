// SPDX-License-Identifier: MIT
/**
 * fbb-auth.ts — F6FBB's MD5 forwarding-link authentication. A called BBS that protects a
 * forwarding partner emits a challenge carrying a 10-digit unix timestamp in brackets
 * (`… [0001234567]`); the caller answers with `MD5(sprintf("%010ld%s", timestamp, password))` as an
 * uppercase hex digest, and the BBS recomputes it against the partner's configured password. The
 * shared secret never crosses the link. Reimplemented from the FBB source (`src/mbl_sys.c`):
 *   sprintf(source, "%010ld%s", pass_time, password); MD5String(dest, source);
 * MD5 is implemented here (WebCrypto has no MD5, and packages/* stay dependency-light + MIT-clean).
 */

/** Extract the 10-digit challenge timestamp from an FBB prompt line, or null if absent. */
export function fbbChallengeTime(line: string): string | null {
  const m = /\[(\d{10})\]/.exec(line);
  return m ? m[1]! : null;
}

/** The MD5 forwarding-auth response: uppercase hex of MD5("%010d" timestamp + password). */
export function fbbAuthResponse(timestamp: string, password: string): string {
  return md5Hex(`${timestamp}${password}`).toUpperCase();
}

/** Verify a peer's response against the expected timestamp + password (constant-time-ish compare). */
export function fbbAuthVerify(timestamp: string, password: string, response: string): boolean {
  const expect = fbbAuthResponse(timestamp, password);
  if (expect.length !== response.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ response.toUpperCase().charCodeAt(i);
  return diff === 0;
}

// ---- compact RFC 1321 MD5 (bytes → 16-byte digest → hex) ----
function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const digest = md5(bytes);
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function md5(msg: Uint8Array): Uint8Array {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
    21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  const origLen = msg.length;
  const bitLen = origLen * 8;
  const withOne = origLen + 1;
  const padded = new Uint8Array((Math.ceil((withOne + 8) / 64) * 64) | 0);
  padded.set(msg);
  padded[origLen] = 0x80;
  // 64-bit little-endian length (bitLen fits in 53-bit JS int for our short inputs)
  for (let i = 0; i < 8; i++) padded[padded.length - 8 + i] = (bitLen / 2 ** (8 * i)) & 0xff;

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = padded[j]! | (padded[j + 1]! << 8) | (padded[j + 2]! << 16) | (padded[j + 3]! << 24);
    }
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      F = (F + A + K[i]! + M[g]!) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, s[i]!)) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  for (const [k, v] of [a0, b0, c0, d0].entries()) {
    out[k * 4] = v & 0xff;
    out[k * 4 + 1] = (v >>> 8) & 0xff;
    out[k * 4 + 2] = (v >>> 16) & 0xff;
    out[k * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));
