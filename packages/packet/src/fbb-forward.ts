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
  private buf: Uint8Array = new Uint8Array(0);
  private binDecoder: BinaryTransferDecoder | null = null; // active only while reading compressed bodies
  private binRemaining = 0; // compressed message transfers still to read this block
  done = false;

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
    this.buf = concat([this.buf, bytes]);
    const out: Uint8Array[] = [];
    let pos = 0;
    while (pos < this.buf.length) {
      if (this.binRemaining > 0) {
        // Compressed-body mode: feed one byte at a time so we can hand control back to line mode the
        // instant the expected number of block transfers have completed.
        const transfers = this.binDecoder!.push(this.buf.subarray(pos, pos + 1));
        pos++;
        for (const t of transfers) {
          this.frame(this.session.feedBinary(t), out);
          this.drainBinary(out);
          if (--this.binRemaining === 0) {
            this.binDecoder = null;
            break;
          }
        }
        continue;
      }
      const nl = this.nextNewline(pos);
      if (nl < 0) break; // partial line — keep the tail buffered
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
    this.buf = this.buf.subarray(pos);
    return out.length ? concat(out) : null;
  }

  private nextNewline(from: number): number {
    for (let i = from; i < this.buf.length; i++) {
      const b = this.buf[i]!;
      if (b === 0x0d || b === 0x0a) return i;
    }
    return -1;
  }

  private frame(lines: string[], out: Uint8Array[]): void {
    if (lines.length) out.push(enc(lines.map((l) => l + "\r").join("")));
  }

  private drainBinary(out: Uint8Array[]): void {
    for (const block of this.session.takeBinary()) out.push(block);
  }
}
