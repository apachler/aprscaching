// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { kissFrames, kissWrap, decodeAx25, encodeAx25 } from "@aprsweb/aprs";
import { encodeFrame, type Ax25Frame } from "@aprsweb/ax25";
import type { Packet, } from "@aprsweb/shared";
import type { ParsedFrame } from "@aprsweb/aprs";

export interface KissOpts { host: string; port: number }
export interface KissHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void;       // UI-decoded RF frame (for the APRS digipeater / igate)
  onRaw?: (bytes: Uint8Array) => void;       // raw KISS-unwrapped AX.25 frame (for connected-mode: node/digi)
}

/**
 * KISS-over-TCP TNC client (e.g. Direwolf on :8001). Reassembles KISS frames, decodes the AX.25
 * UI frame, forwards each as an `rf`-heard packet on the `kiss-tnc` port, and exposes send() so a
 * digipeater / TX-IGate can transmit. Auto-reconnects.
 */
export class KissTnc {
  private sock?: net.Socket;
  private connected = false;
  private buf: number[] = [];
  constructor(private o: KissOpts, private h: KissHandlers) {}

  start() { this.connect(); }

  /** Transmit an AX.25 UI frame over KISS (best-effort; dropped if the TNC link is down). */
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean {
    if (!this.connected || !this.sock) return false;
    try { this.sock.write(kissWrap(encodeAx25(f))); return true; } catch { return false; }
  }

  /** Transmit a full AX.25 frame (any type — for connected-mode: NET/ROM node, connected digi). */
  sendFrame(f: Ax25Frame): boolean {
    if (!this.connected || !this.sock) return false;
    try { this.sock.write(kissWrap(encodeFrame(f))); return true; } catch { return false; }
  }

  private connect() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.on("connect", () => { this.connected = true; console.log(`[kiss] connected ${this.o.host}:${this.o.port}`); });
    s.on("data", (chunk: Buffer) => {
      for (const b of chunk) this.buf.push(b);
      const lastFend = this.buf.lastIndexOf(0xc0);
      if (lastFend <= 0) return;
      const ready = Uint8Array.from(this.buf.slice(0, lastFend + 1));
      this.buf = this.buf.slice(lastFend + 1);
      for (const raw of kissFrames(ready)) {
        this.h.onRaw?.(raw);                    // raw AX.25 for connected-mode consumers (node/digi)
        const f = decodeAx25(raw);
        if (!f) continue;
        this.h.onFrame?.(f);
        this.h.onPacket({
          src: f.src, dst: f.dst, path: f.path, payload: f.payload,
          kind: "other", heardVia: "rf", port: "kiss-tnc",
          ts: Math.floor(Date.now() / 1000), raw: f.raw,
        });
      }
    });
    const down = () => { this.connected = false; };
    s.on("error", () => { down(); console.log("[kiss] disconnected, retrying…"); });
    s.on("close", () => { down(); setTimeout(() => this.connect(), 3000); });
  }
}
