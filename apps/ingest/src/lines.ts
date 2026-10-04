// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * lines.ts — the line splitter for APRS-IS text streams. A partial line is held until its newline arrives,
 * but never past `maxBytes`: a server (or a misdirected port) that never sends a newline would otherwise grow
 * the buffer without bound. An over-long line is dropped whole: its held part at once, the rest up to the next
 * newline as it arrives.
 */

/** Longest APRS-IS line kept; real lines stay far below it (APRS-IS caps a packet at 512 bytes). */
export const LINE_MAX_BYTES = 4096;

export class LineBuffer {
  private buf = "";
  private skipping = false;
  /** Over-long lines dropped since start. */
  dropped = 0;

  constructor(private maxBytes = LINE_MAX_BYTES) {}

  /** Feed a chunk; returns the complete lines it finished, without their CR/LF. */
  push(chunk: string): string[] {
    const out: string[] = [];
    let rest = chunk;
    let i;
    while ((i = rest.indexOf("\n")) >= 0) {
      const part = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (this.skipping) {
        this.skipping = false; // the newline ends the over-long line
        this.buf = "";
        continue;
      }
      const line = this.buf + part;
      this.buf = "";
      if (line.length > this.maxBytes) {
        this.dropped++;
        continue;
      }
      out.push(line.replace(/\r$/, ""));
    }
    if (this.skipping) return out;
    this.buf += rest;
    if (this.buf.length > this.maxBytes) {
      this.buf = "";
      this.skipping = true;
      this.dropped++;
    }
    return out;
  }

  /** Forget any partial line (a new connection never continues the old one's). */
  reset(): void {
    this.buf = "";
    this.skipping = false;
  }
}
