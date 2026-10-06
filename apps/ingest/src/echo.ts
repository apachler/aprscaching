// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The frames this ingest box transmitted lately, on any of its ports. One box keeps one memory: a frame the KISS
 * TNC's radio sent and the soundcard port's receiver hears (or the reverse) is the box's own signal, and the
 * port that hears it drops it. The box names its receiving site on what it hears directly, and that site must
 * never attest what the box itself sent.
 */

/** How long a sent frame's bytes are remembered, to drop its echo. */
export const ECHO_MS = 30_000;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class SentFrames {
  private sent = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}

  /** Remember a frame's AX.25 bytes as sent now. */
  remember(frame: Uint8Array): void {
    const now = this.now();
    for (const [k, t] of this.sent) if (now - t > ECHO_MS) this.sent.delete(k);
    this.sent.set(hex(frame), now);
  }

  /** True when these AX.25 bytes are a frame this box sent within the echo window. */
  echoes(raw: Uint8Array): boolean {
    const at = this.sent.get(hex(raw));
    return at !== undefined && this.now() - at < ECHO_MS;
  }
}
