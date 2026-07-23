// SPDX-License-Identifier: MIT
/**
 * lzhuf.ts — the F6FBB B0/B1 compression codec, reimplemented from the LZHUF algorithm
 * (Okumura/Yoshizaki adaptive-Huffman LZSS, public domain) with F6FBB's exact parameters: a
 * **2048-byte window** (N), 60-byte lookahead (F), threshold 2, and the classic 6+6-bit position
 * tables. Byte-exact against real F6FBB — the interop suite validates a compressed forwarding
 * session against a containerized xfbbd; the unit tests pin the codec against a reference oracle
 * compiled from the FBB source.
 *
 * Frame layers (see tools/interop/LZHUF-SPEC.md):
 *  - B0 "basic":  [4-byte LE textsize][adaptive-Huffman LZSS stream]
 *  - B1:          [2-byte CRC-16][4-byte LE filesize][stream]  (CRC covers filesize + stream)
 * CRLF normalization (LF → CRLF, lone CR dropped) is the caller's concern; this codec is bytes-in,
 * bytes-out so the compression is isolated exactly as the FBB C code compresses its temp file.
 */

const N = 2048; // ring-buffer (window) size — FBB's value, NOT classic lzhuf's 4096
const F = 60; // lookahead buffer size
const THRESHOLD = 2;
const NIL = N; // tree null pointer
const N_CHAR = 256 - THRESHOLD + F; // 314 kinds of characters
const T = N_CHAR * 2 - 1; // 627 — size of the Huffman table
const R = T - 1; // 626 — position of the root
const MAX_FREQ = 0x8000; // tree-rebuild threshold

// Position-code tables (the classic Okumura public-domain tables (identical in the FBB source)). Upper 6 position bits are table-coded; the
// lower 6 ride verbatim.
// prettier-ignore
const P_LEN = new Uint8Array([
  3, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
]);
// prettier-ignore
const P_CODE = new Uint8Array([
  0, 32, 48, 64, 80, 88, 96, 104, 112, 120, 128, 136, 144, 148, 152, 156,
  160, 164, 168, 172, 176, 180, 184, 188, 192, 194, 196, 198, 200, 202, 204, 206,
  208, 210, 212, 214, 216, 218, 220, 222, 224, 226, 228, 230, 232, 234, 236, 238,
  240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255,
]);
// prettier-ignore
const D_CODE = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7,
  8, 8, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9,
  10, 10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 11, 11,
  12, 12, 12, 12, 13, 13, 13, 13, 14, 14, 14, 14, 15, 15, 15, 15,
  16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19, 19,
  20, 20, 20, 20, 21, 21, 21, 21, 22, 22, 22, 22, 23, 23, 23, 23,
  24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 30, 30, 31, 31,
  32, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37, 38, 38, 39, 39,
  40, 40, 41, 41, 42, 42, 43, 43, 44, 44, 45, 45, 46, 46, 47, 47,
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
]);
// prettier-ignore
const D_LEN = new Uint8Array([
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
]);

// TransIt CRC-16 (poly 0x1021, MSB-first, seed 0) — FBB's `updcrc`/`crctab` for the B1 header.
const CRCTAB = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();
export function fbbCrc16(bytes: Uint8Array, seed = 0): number {
  let crc = seed & 0xffff;
  for (const b of bytes) crc = (CRCTAB[((crc >> 8) & 0xff) ^ b]! ^ (crc << 8)) & 0xffff;
  return crc;
}

/** One shared codec state instance — mirrors Okumura's public-domain LZHUF.C state (the FBB source keeps the same shape); a fresh instance per encode/decode. */
class Coder {
  // adaptive-Huffman tree
  private freq = new Uint16Array(T + 1);
  private prnt = new Int32Array(T + N_CHAR);
  private son = new Int32Array(T); // `fils[]` in the source
  // LZSS ring buffer + binary search tree
  private textBuf = new Uint8Array(N + F - 1);
  private lson = new Int32Array(N + 1);
  private rson = new Int32Array(N + 257);
  private dad = new Int32Array(N + 1);
  private matchPos = 0;
  private matchLen = 0;
  // bit I/O
  private out: number[] = [];
  private inp: Uint8Array = new Uint8Array(0);
  private ip = 0;
  private getbuf = 0;
  private getlen = 0;
  private putbuf = 0;
  private putlen = 0; // bits accumulated in putbuf (FBB starts at 0)

  private startHuff(): void {
    for (let i = 0; i < N_CHAR; i++) {
      this.freq[i] = 1;
      this.son[i] = i + T;
      this.prnt[i + T] = i;
    }
    let i = 0;
    let j = N_CHAR;
    while (j <= R) {
      this.freq[j] = (this.freq[i]! + this.freq[i + 1]!) & 0xffff;
      this.son[j] = i;
      this.prnt[i] = this.prnt[i + 1] = j;
      i += 2;
      j++;
    }
    this.freq[T] = 0xffff;
    this.prnt[R] = 0;
  }

  private reconst(): void {
    let j = 0;
    for (let i = 0; i < T; i++) {
      if (this.son[i]! >= T) {
        this.freq[j] = (this.freq[i]! + 1) >> 1;
        this.son[j] = this.son[i]!;
        j++;
      }
    }
    for (let i = 0, jj = N_CHAR; jj < T; i += 2, jj++) {
      const f = (this.freq[jj] = (this.freq[i]! + this.freq[i + 1]!) & 0xffff);
      let k = jj - 1;
      while (f < this.freq[k]!) k--;
      k++;
      // shift [k, jj) up by one (memmove of (jj-k) elements)
      for (let m = jj; m > k; m--) {
        this.freq[m] = this.freq[m - 1]!;
        this.son[m] = this.son[m - 1]!;
      }
      this.freq[k] = f;
      this.son[k] = i;
    }
    for (let i = 0; i < T; i++) {
      const k = this.son[i]!;
      if (k >= T) this.prnt[k] = i;
      else this.prnt[k] = this.prnt[k + 1] = i;
    }
  }

  private update(c: number): void {
    if (this.freq[R] === MAX_FREQ) this.reconst();
    c = this.prnt[c + T]!;
    do {
      const k = (this.freq[c] = (this.freq[c]! + 1) & 0xffff);
      let l = c + 1;
      if (k > this.freq[l]!) {
        while (k > this.freq[++l]!);
        l--;
        this.freq[c] = this.freq[l]!;
        this.freq[l] = k;
        const i = this.son[c]!;
        this.prnt[i] = l;
        if (i < T) this.prnt[i + 1] = l;
        const jj = this.son[l]!;
        this.son[l] = i;
        this.prnt[jj] = c;
        if (jj < T) this.prnt[jj + 1] = c;
        this.son[c] = jj;
        c = l;
      }
    } while ((c = this.prnt[c]!) !== 0);
  }

  // ---- bit output (verbatim port of the FBB Putcode/EncodeEnd) ----
  private putcode(l: number, c: number): void {
    c &= 0xffff;
    this.putbuf = (this.putbuf | (c >> this.putlen)) & 0xffff;
    this.putlen += l;
    if (this.putlen >= 8) {
      this.out.push((this.putbuf >> 8) & 0xff);
      this.putlen -= 8;
      if (this.putlen >= 8) {
        this.out.push(this.putbuf & 0xff);
        this.putlen -= 8;
        this.putbuf = (c << (l - this.putlen)) & 0xffff;
      } else {
        this.putbuf = (this.putbuf << 8) & 0xffff;
      }
    }
  }
  private encodeEnd(): void {
    if (this.putlen) this.out.push((this.putbuf >> 8) & 0xff);
  }
  private encodeChar(c: number): void {
    let i = 0;
    let j = 0;
    let k = this.prnt[c + T]!;
    do {
      i >>= 1;
      if (k & 1) i += 0x8000;
      j++;
    } while ((k = this.prnt[k]!) !== R);
    this.putcode(j, i);
    this.update(c);
  }
  private encodePosition(c: number): void {
    const i = c >> 6;
    this.putcode(P_LEN[i]!, P_CODE[i]! << 8);
    this.putcode(6, (c & 0x3f) << 10);
  }

  // ---- bit input ----
  private nextByte(): number {
    return this.ip < this.inp.length ? this.inp[this.ip++]! : 0;
  }
  private getBit(): number {
    while (this.getlen <= 8) {
      this.getbuf = (this.getbuf | (this.nextByte() << (8 - this.getlen))) & 0xffff;
      this.getlen += 8;
    }
    const i = this.getbuf;
    this.getbuf = (this.getbuf << 1) & 0xffff;
    this.getlen--;
    return (i >> 15) & 1;
  }
  private getByte(): number {
    while (this.getlen <= 8) {
      this.getbuf = (this.getbuf | (this.nextByte() << (8 - this.getlen))) & 0xffff;
      this.getlen += 8;
    }
    const i = this.getbuf;
    this.getbuf = (this.getbuf << 8) & 0xffff;
    this.getlen -= 8;
    return (i >> 8) & 0xff;
  }
  private decodeChar(): number {
    let c = this.son[R]!;
    while (c < T) {
      c += this.getBit();
      c = this.son[c]!;
    }
    c -= T;
    this.update(c);
    return c;
  }
  private decodePosition(): number {
    let i = this.getByte();
    const c = D_CODE[i]! << 6;
    let j = D_LEN[i]!;
    j -= 2;
    while (j-- > 0) i = ((i << 1) + this.getBit()) & 0xff;
    return c | (i & 0x3f);
  }

  // ---- LZSS tree ----
  private initTree(): void {
    for (let i = N + 1; i <= N + 256; i++) this.rson[i] = NIL;
    for (let i = 0; i < N; i++) this.dad[i] = NIL;
  }
  private insertNode(r: number): void {
    let cmp = 1;
    const key = r;
    let p = N + 1 + this.textBuf[key]!;
    this.rson[r] = this.lson[r] = NIL;
    this.matchLen = 0;
    for (;;) {
      if (cmp >= 0) {
        if (this.rson[p] !== NIL) p = this.rson[p]!;
        else {
          this.rson[p] = r;
          this.dad[r] = p;
          return;
        }
      } else {
        if (this.lson[p] !== NIL) p = this.lson[p]!;
        else {
          this.lson[p] = r;
          this.dad[r] = p;
          return;
        }
      }
      let i: number;
      for (i = 1; i < F; i++) {
        cmp = this.textBuf[key + i]! - this.textBuf[p + i]!;
        if (cmp !== 0) break;
      }
      if (i > THRESHOLD) {
        if (i > this.matchLen) {
          this.matchPos = ((r - p) & (N - 1)) - 1;
          this.matchLen = i;
          if (this.matchLen >= F) break;
        } else if (i === this.matchLen) {
          const c = ((r - p) & (N - 1)) - 1;
          if (c < this.matchPos) this.matchPos = c;
        }
      }
    }
    this.dad[r] = this.dad[p]!;
    this.lson[r] = this.lson[p]!;
    this.rson[r] = this.rson[p]!;
    this.dad[this.lson[p]!] = r;
    this.dad[this.rson[p]!] = r;
    if (this.rson[this.dad[p]!] === p) this.rson[this.dad[p]!] = r;
    else this.lson[this.dad[p]!] = r;
    this.dad[p] = NIL;
  }
  private deleteNode(p: number): void {
    if (this.dad[p] === NIL) return;
    let q: number;
    if (this.rson[p] === NIL) q = this.lson[p]!;
    else if (this.lson[p] === NIL) q = this.rson[p]!;
    else {
      q = this.lson[p]!;
      if (this.rson[q] !== NIL) {
        do q = this.rson[q]!;
        while (this.rson[q] !== NIL);
        this.rson[this.dad[q]!] = this.lson[q]!;
        this.dad[this.lson[q]!] = this.dad[q]!;
        this.lson[q] = this.lson[p]!;
        this.dad[this.lson[p]!] = q;
      }
      this.rson[q] = this.rson[p]!;
      this.dad[this.rson[p]!] = q;
    }
    this.dad[q] = this.dad[p]!;
    if (this.rson[this.dad[p]!] === p) this.rson[this.dad[p]!] = q;
    else this.lson[this.dad[p]!] = q;
    this.dad[p] = NIL;
  }

  /** Compress raw bytes → the adaptive-Huffman LZSS stream (no framing). */
  encode(src: Uint8Array): Uint8Array {
    this.out = [];
    this.putbuf = 0;
    this.putlen = 0;
    this.startHuff();
    this.initTree();
    let sp = 0; // source read pointer
    let s = 0;
    let r = N - F;
    for (let i = s; i < r; i++) this.textBuf[i] = 0x20;
    let len: number;
    for (len = 0; len < F && sp < src.length; len++) this.textBuf[r + len] = src[sp++]!;
    for (let i = 1; i <= F; i++) this.insertNode(r - i);
    this.insertNode(r);
    do {
      if (this.matchLen > len) this.matchLen = len;
      if (this.matchLen <= THRESHOLD) {
        this.matchLen = 1;
        this.encodeChar(this.textBuf[r]!);
      } else {
        this.encodeChar(255 - THRESHOLD + this.matchLen);
        this.encodePosition(this.matchPos);
      }
      const lastLen = this.matchLen;
      let i: number;
      for (i = 0; i < lastLen && sp < src.length; i++) {
        const c = src[sp++]!;
        this.deleteNode(s);
        this.textBuf[s] = c;
        if (s < F - 1) this.textBuf[s + N] = c;
        s = (s + 1) & (N - 1);
        r = (r + 1) & (N - 1);
        this.insertNode(r);
      }
      while (i++ < lastLen) {
        this.deleteNode(s);
        s = (s + 1) & (N - 1);
        r = (r + 1) & (N - 1);
        if (--len) this.insertNode(r);
      }
    } while (len > 0);
    this.encodeEnd();
    return Uint8Array.from(this.out);
  }

  /** Decompress `size` bytes from the adaptive-Huffman LZSS stream. */
  decode(stream: Uint8Array, size: number): Uint8Array {
    this.inp = stream;
    this.ip = 0;
    this.getbuf = 0;
    this.getlen = 0;
    this.startHuff();
    const out = new Uint8Array(size);
    let op = 0;
    let r = N - F;
    for (let i = 0; i < N - F; i++) this.textBuf[i] = 0x20;
    while (op < size) {
      const c = this.decodeChar();
      if (c < 256) {
        out[op++] = c;
        this.textBuf[r++] = c;
        r &= N - 1;
      } else {
        const pos = (r - this.decodePosition() - 1) & (N - 1);
        const j = c - 255 + THRESHOLD;
        for (let k = 0; k < j && op < size; k++) {
          const b = this.textBuf[(pos + k) & (N - 1)]!;
          out[op++] = b;
          this.textBuf[r++] = b;
          r &= N - 1;
        }
      }
    }
    return out;
  }
}

const le32 = (n: number): Uint8Array =>
  new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const rd32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** B0: [LE32 size][stream]. Empty input is just the zero size prefix (FBB returns before coding). */
export function lzhufEncodeB0(raw: Uint8Array): Uint8Array {
  const stream = raw.length ? new Coder().encode(raw) : new Uint8Array(0);
  return concat(le32(raw.length), stream);
}
export function lzhufDecodeB0(frame: Uint8Array): Uint8Array {
  const size = rd32(frame, 0);
  if (size === 0) return new Uint8Array(0);
  return new Coder().decode(frame.subarray(4), size);
}

/** B1: [LE16 CRC][LE32 size][stream]; the CRC covers the size bytes + the stream. */
export function lzhufEncodeB1(raw: Uint8Array): Uint8Array {
  const stream = new Coder().encode(raw);
  const sizeAndStream = concat(le32(raw.length), stream);
  const crc = fbbCrc16(sizeAndStream);
  return concat(new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]), sizeAndStream);
}
export function lzhufDecodeB1(frame: Uint8Array): { data: Uint8Array; crcOk: boolean } {
  const crc = frame[0]! | (frame[1]! << 8);
  const body = frame.subarray(2);
  const size = rd32(body, 0);
  const crcOk = fbbCrc16(body) === crc;
  return { data: new Coder().decode(body.subarray(4), size), crcOk };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** LF → CRLF, drop lone CR — the body normalization FBB applies before compressing. */
export function toCrlf(s: string): Uint8Array {
  return new TextEncoder().encode(s.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));
}
