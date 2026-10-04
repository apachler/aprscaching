// SPDX-License-Identifier: MIT
/**
 * fbb-forward.ts — a byte-stream driver around FbbSession. The FbbSession is command-oriented
 * (one CR/LF-terminated line per feed, plus binary block transfers in compressed mode); a real
 * connected-mode AX.25 link (or an AXUDP tunnel) carries an opaque byte stream. This wraps the session
 * with line framing AND the compressed-body block framing, so the ingest can pump raw I-frame payloads in
 * and get raw payloads out. The buffer is bytes (never decoded as UTF-8) because a compressed body is
 * arbitrary bytes that must not be mangled — only complete command lines are decoded to text.
 */
import { FbbSession, type FbbStore } from "./fbb-session.js";
import { BinaryTransferDecoder } from "./fbb-binary.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
// Command lines are 7-bit ASCII; decode latin1-style so a stray high byte can't throw or reorder.
const decLine = (b: Uint8Array): string => {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
};

/**
 * The longest command line the forwarder buffers: 8 KiB. FBB command lines (SID, proposals, FS replies,
 * titles) are far shorter, so a peer that sends more without a line break ends the session.
 */
export const FBB_MAX_LINE = 8 * 1024;

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** One side of an FBB forwarding exchange over a byte link. Command lines are CR-terminated (FBB wire). */
export class FbbForwarder {
  private session: FbbSession;
  private mem: Uint8Array = new Uint8Array(1024); // received bytes not yet consumed live in mem[0, held)
  private held = 0;
  private buf: Uint8Array = new Uint8Array(0); // the unconsumed bytes during one onData call
  private binDecoder: BinaryTransferDecoder | null = null; // active only while reading compressed bodies
  private binRemaining = 0; // compressed message transfers still to read this block
  private scanned = 0; // bytes of `buf` already searched for a line break
  done = false;
  /** The session ended because the peer's input could not be processed (an over-long line, a body that
   *  cannot be decompressed), not by an ordinary FQ. */
  aborted = false;

  constructor(store: FbbStore, opts: { initiator: boolean; sid?: string; compress?: boolean }) {
    this.session = new FbbSession(store, opts);
  }

  /** Bytes to transmit when the link comes up (the initiator opens with its SID + first block). */
  start(): Uint8Array | null {
    const out: Uint8Array[] = [];
    this.frame(this.session.start(), out);
    this.drainBinary(out);
    return out.length ? concat(out) : null;
  }

  /** Feed received link bytes; returns bytes to transmit (or null) and sets `done` when the session ends. */
  onData(bytes: Uint8Array): Uint8Array | null {
    if (this.done) return null;
    this.append(bytes);
    this.buf = this.mem.subarray(0, this.held);
    const out: Uint8Array[] = [];
    let pos = 0;
    while (pos < this.buf.length) {
      if (this.binRemaining > 0) {
        // Compressed-body mode: feed one byte at a time so we can hand control back to line mode the
        // instant the expected number of block transfers have completed.
        const transfers = this.binDecoder!.push(this.buf.subarray(pos, pos + 1));
        pos++;
        for (const t of transfers) {
          const r = this.session.feedBinary(t);
          this.frame(r.out, out);
          this.drainBinary(out);
          if (r.done) {
            this.binRemaining = 0;
            this.binDecoder = null;
            this.done = this.aborted = true;
            break;
          }
          if (--this.binRemaining === 0) {
            this.binDecoder = null;
            break;
          }
        }
        if (this.done) {
          pos = this.buf.length;
          break;
        }
        continue;
      }
      const nl = this.nextNewline(pos);
      // a partial line stays buffered; one longer than the line ceiling, complete or not, ends the session
      if ((nl < 0 ? this.buf.length : nl) - pos > FBB_MAX_LINE) {
        this.frame(["FQ"], out);
        this.done = this.aborted = true;
        pos = this.buf.length;
        break;
      }
      if (nl < 0) break;
      const line = decLine(this.buf.subarray(pos, nl));
      pos = nl + 1;
      if (line === "") continue; // skip blank separators between CR/LF pairs
      const r = this.session.feed(line);
      this.frame(r.out, out);
      this.drainBinary(out);
      if (r.done) {
        this.done = true;
        pos = this.buf.length;
        break;
      }
      const expect = this.session.expectingBinary();
      if (expect > 0) {
        this.binRemaining = expect;
        this.binDecoder = new BinaryTransferDecoder();
      }
    }
    // Keep only the unconsumed tail: a held partial line is at most FBB_MAX_LINE bytes, so moving it
    // to the front costs no more than the line itself.
    if (this.done) this.held = 0;
    else if (pos > 0) {
      this.mem.copyWithin(0, pos, this.held);
      this.held -= pos;
    }
    if (this.held === 0 && this.mem.length > 64 * 1024) this.mem = new Uint8Array(1024); // after a large body
    this.buf = new Uint8Array(0);
    this.scanned = Math.max(0, this.scanned - pos);
    return out.length ? concat(out) : null;
  }

  /** Add received bytes behind the held ones, growing the store by doubling. */
  private append(bytes: Uint8Array): void {
    const need = this.held + bytes.length;
    if (need > this.mem.length) {
      const grown = new Uint8Array(Math.max(need, this.mem.length * 2));
      grown.set(this.mem.subarray(0, this.held));
      this.mem = grown;
    }
    this.mem.set(bytes, this.held);
    this.held = need;
  }

  /** The next line break at or after `from`, never rescanning bytes an earlier call already searched. */
  private nextNewline(from: number): number {
    for (let i = Math.max(from, this.scanned); i < this.buf.length; i++) {
      const b = this.buf[i]!;
      if (b === 0x0d || b === 0x0a) {
        this.scanned = i + 1;
        return i;
      }
    }
    this.scanned = this.buf.length;
    return -1;
  }

  private frame(lines: string[], out: Uint8Array[]): void {
    if (lines.length) out.push(enc(lines.map((l) => l + "\r").join("")));
  }

  private drainBinary(out: Uint8Array[]): void {
    for (const block of this.session.takeBinary()) out.push(block);
  }
}
