// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * serialKiss.ts — a Web Serial KISS transport for connected-mode packet. Bridges the
 * serial byte stream ⇄ raw AX.25 frames: incoming bytes are de-KISS'd + decoded into typed frames for
 * the TerminalSession, and outgoing frames are encoded + KISS-wrapped. It implements @aprscaching/packet's
 * synchronous Transport.send by queueing the write (fire-and-forget). Chromium-only + session-bound,
 * exactly like the RX-only browser ingest — operator-local RF.
 */
import { encodeFrame, decodeFrame, type Ax25Frame } from "@aprscaching/ax25";
import { KissDecoder, kissWrap } from "@aprscaching/aprs";
import type { Transport } from "@aprscaching/packet";

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export const webSerialSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof (navigator as { serial?: { requestPort?: unknown } }).serial?.requestPort === "function";

/**
 * A KISS byte feeder for connected mode: hands each completed data frame, decoded to AX.25, to onFrame. The
 * streaming KissDecoder keeps a partial frame across reads, so a frame split over USB reads or BLE
 * notifications arrives whole; KISS command frames are skipped.
 */
export function ax25Feeder(onFrame: (f: Ax25Frame) => void): (chunk: Uint8Array) => void {
  const rx = new KissDecoder();
  return (chunk) => {
    for (const k of rx.push(chunk)) {
      if (k.command !== 0) continue; // a KISS command, not a frame
      const f = decodeFrame(k.frame);
      if (f) onFrame(f);
    }
  };
}

export class SerialKissTransport implements Transport {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;
  private feed: (chunk: Uint8Array) => void;

  constructor(
    private onFrame: (f: Ax25Frame) => void,
    private onClose?: (err?: Error) => void,
  ) {
    this.feed = ax25Feeder(onFrame);
  }

  /** Prompt for a serial port (needs a user gesture), open it, and start reading KISS frames. */
  async connect(baudRate = 9600): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    this.port = await serial.requestPort();
    await this.port.open({ baudRate });
    this.closed = false;
    this.feed = ax25Feeder(this.onFrame); // a reopened port must not complete the last session's partial frame
    if (this.port.writable) this.writer = this.port.writable.getWriter();
    void this.readLoop();
  }

  /** Transport.send — encode + KISS-wrap + queue the write (the session calls this synchronously). */
  send(frame: Ax25Frame): void {
    void this.write(kissWrap(encodeFrame(frame)));
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.write(bytes);
    } catch (e) {
      if (!this.closed) this.onClose?.(e as Error);
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
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (e) {
      err = e as Error;
    }
    if (this.closed) return;
    // A lost link closes the port before it is reported, so the next connect can open it again.
    await this.disconnect();
    this.onClose?.(err);
  }

  /** Close the port; safe to call again on a link that is already closed. */
  async disconnect(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already closed */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.writer = null;
    try {
      await this.port?.close();
    } catch {
      /* already closed */
    }
    this.port = null;
  }
}
