// SPDX-License-Identifier: MIT
/**
 * fbb-forward.ts — a byte-stream driver around FbbSession. The FbbSession is line-oriented
 * (one CR/LF-terminated command per feed); a real connected-mode AX.25 link (or an AXUDP tunnel) carries
 * an opaque byte stream. This wraps the session with the line buffering + CR framing so the ingest can
 * pump raw I-frame payloads in and get raw payloads out, exactly like link-app.ts wraps a LineApp for the
 * server side. Pure — the ingest supplies the ConnectedLink; the loopback harness supplies a byte channel.
 */
import { FbbSession, type FbbStore } from "./fbb-session.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** One side of an FBB forwarding exchange over a byte link. Frame lines are CR-terminated (FBB wire). */
export class FbbForwarder {
  private session: FbbSession;
  private buf = "";
  done = false;

  constructor(store: FbbStore, opts: { initiator: boolean; sid?: string }) {
    this.session = new FbbSession(store, opts);
  }

  /** Bytes to transmit when the link comes up (the initiator opens with its SID + first block). */
  start(): Uint8Array | null {
    return this.frame(this.session.start());
  }

  /** Feed received link bytes; returns bytes to transmit (or null) and sets `done` when the session ends. */
  onData(bytes: Uint8Array): Uint8Array | null {
    this.buf += dec(bytes);
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.search(/[\r\n]/)) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line === "" ) continue;                       // skip blank separators between CR/LF pairs
      const r = this.session.feed(line);
      out.push(...r.out);
      if (r.done) { this.done = true; break; }          // FQ ends the session — never feed trailing lines
    }
    return this.frame(out);
  }

  private frame(lines: string[]): Uint8Array | null {
    return lines.length ? enc(lines.map((l) => l + "\r").join("")) : null;
  }
}
