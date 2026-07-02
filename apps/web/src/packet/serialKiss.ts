// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * serialKiss.ts — a Web Serial KISS transport for connected-mode packet (docs/design/25 P1). Bridges the
 * serial byte stream ⇄ raw AX.25 frames: incoming bytes are de-KISS'd + decoded into typed frames for
 * the TerminalSession, and outgoing frames are encoded + KISS-wrapped. It implements @aprsweb/packet's
 * synchronous Transport.send by queueing the write (fire-and-forget). Chromium-only + session-bound,
 * exactly like the RX-only browser ingest (docs/design/16 H1, ingest-locality) — operator-local RF.
 */
import { encodeFrame, decodeFrame, type Ax25Frame } from "@aprsweb/ax25";
import { kissFrames, kissWrap } from "@aprsweb/aprs";
import type { Transport } from "@aprsweb/packet";

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export const webSerialSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof (navigator as { serial?: { requestPort?: unknown } }).serial?.requestPort === "function";

export class SerialKissTransport implements Transport {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;
  private buf: number[] = [];

  constructor(private onFrame: (f: Ax25Frame) => void, private onClose?: (err?: Error) => void) {}

  /** Prompt for a serial port (needs a user gesture), open it, and start reading KISS frames. */
  async connect(baudRate = 9600): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    this.port = await serial.requestPort();
    await this.port.open({ baudRate });
    this.closed = false;
    if (this.port.writable) this.writer = this.port.writable.getWriter();
    void this.readLoop();
  }

  /** Transport.send — encode + KISS-wrap + queue the write (the session calls this synchronously). */
  send(frame: Ax25Frame): void { void this.write(kissWrap(encodeFrame(frame))); }

  private async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) return;
    try { await this.writer.write(bytes); } catch (e) { if (!this.closed) this.onClose?.(e as Error); }
  }

  private feed(chunk: Uint8Array): void {
    for (const b of chunk) this.buf.push(b);
    const lastFend = this.buf.lastIndexOf(0xc0);
    if (lastFend <= 0) return;                          // wait for a complete FEND-delimited frame
    const ready = Uint8Array.from(this.buf.slice(0, lastFend + 1));
    this.buf = this.buf.slice(lastFend + 1);
    for (const raw of kissFrames(ready)) {
      const f = decodeFrame(raw);
      if (f) this.onFrame(f);
    }
  }

  private async readLoop(): Promise<void> {
    let err: Error | undefined;
    try {
      while (this.port?.readable && !this.closed) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) this.feed(value);
          }
        } finally { this.reader.releaseLock(); this.reader = null; }
      }
    } catch (e) { err = e as Error; }
    finally { if (!this.closed) this.onClose?.(err); }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    this.writer = null;
    try { await this.port?.close(); } catch { /* already closed */ }
    this.port = null;
  }
}
