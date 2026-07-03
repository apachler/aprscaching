// SPDX-License-Identifier: AGPL-3.0-or-later
import { webSerialSupported } from "./kiss.js";

/**
 * Web Serial line reader for a USB weather station. Opens the chosen serial port,
 * decodes the byte stream to text, and emits complete CR/LF-terminated lines — the caller decodes
 * each line (e.g. Ultimeter `!!` / `$ULTW`). Mirrors the WebSerialKiss plumbing but ASCII/line-based.
 * Chromium-only and session-bound, like the rest of the browser hardware path; provide a fallback.
 */
export { webSerialSupported };

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export class WebSerialWeather {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private buf = "";

  constructor(
    private onLine: (line: string) => void,
    private baudRate = 2400,
  ) {}

  async connect(): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    this.port = await serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const dec = new TextDecoder();
    while (this.port?.readable && !this.closed) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          this.buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = this.buf.search(/[\r\n]/)) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (line) this.onLine(line);
          }
          if (this.buf.length > 4096) this.buf = ""; // never let a noisy port grow unbounded
        }
      } catch {
        /* port hiccup — outer loop re-acquires the reader */
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* */
    }
    try {
      await this.port?.close();
    } catch {
      /* */
    }
    this.port = null;
  }
}
