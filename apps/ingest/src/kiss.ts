import net from "node:net";
import { kissFrames, decodeAx25 } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";

export interface KissOpts { host: string; port: number }

/**
 * KISS-over-TCP TNC client (e.g. Direwolf on :8001). Reassembles KISS frames, decodes the AX.25
 * UI frame, and forwards each as an `rf`-heard packet on the `kiss-tnc` port. Auto-reconnects.
 */
export class KissTnc {
  private sock?: net.Socket;
  private buf: number[] = [];
  constructor(private o: KissOpts, private onPacket: (p: Packet) => void) {}

  start() { this.connect(); }

  private connect() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.on("connect", () => console.log(`[kiss] connected ${this.o.host}:${this.o.port}`));
    s.on("data", (chunk: Buffer) => {
      for (const b of chunk) this.buf.push(b);
      // a trailing FEND closes the last frame; decode whole buffer, keep any partial tail
      const lastFend = this.buf.lastIndexOf(0xc0);
      if (lastFend <= 0) return;
      const ready = Uint8Array.from(this.buf.slice(0, lastFend + 1));
      this.buf = this.buf.slice(lastFend + 1);
      for (const raw of kissFrames(ready)) {
        const f = decodeAx25(raw);
        if (!f) continue;
        this.onPacket({
          src: f.src, dst: f.dst, path: f.path, payload: f.payload,
          kind: "other", heardVia: "rf", port: "kiss-tnc",
          ts: Math.floor(Date.now() / 1000), raw: f.raw,
        });
      }
    });
    const retry = () => { setTimeout(() => this.connect(), 3000); };
    s.on("error", () => { console.log("[kiss] disconnected, retrying…"); });
    s.on("close", retry);
  }
}
