// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * bleKiss.ts — a Web Bluetooth KISS transport for connected-mode packet, the Bluetooth twin of
 * serialKiss.ts. It rides the shared BLE KISS byte link (rf/bleKiss.ts): notifications feed the same
 * streaming KISS decoder, and each outgoing frame is encoded, KISS-wrapped and queued as 20-byte writes.
 * Transport.send is synchronous, so the write is fire-and-forget; a failed write closes the session like a
 * failed serial write. Transmit is gated on callsign control-verification by the TerminalSession.
 */
import { encodeFrame, type Ax25Frame } from "@aprscaching/ax25";
import { kissWrap } from "@aprscaching/aprs";
import type { Transport } from "@aprscaching/packet";
import { BleKissLink } from "../rf/bleKiss.js";
import { ax25Feeder } from "./serialKiss.js";

export class BleKissTransport implements Transport {
  private link: BleKissLink | null = null;
  private closed = false;

  constructor(
    private onFrame: (f: Ax25Frame) => void,
    private onClose?: (err?: Error) => void,
  ) {}

  /** Prompt for a Bluetooth TNC (needs a user gesture), connect, and start reading KISS frames. */
  async connect(): Promise<void> {
    // a fresh link and decoder per connection: a reconnect must not complete the last session's partial frame
    const link = new BleKissLink(ax25Feeder(this.onFrame), () => {
      if (!this.closed) this.onClose?.(new Error("the Bluetooth TNC disconnected"));
    });
    this.closed = false;
    await link.connect();
    this.link = link;
  }

  /** Transport.send — encode + KISS-wrap + queue the write (the session calls this synchronously). */
  send(frame: Ax25Frame): void {
    const link = this.link;
    if (!link) return;
    link.write(kissWrap(encodeFrame(frame))).catch((e: Error) => {
      if (!this.closed) this.onClose?.(e);
    });
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    await this.link?.disconnect();
    this.link = null;
  }
}
