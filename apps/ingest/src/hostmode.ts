// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { parseTNC2 } from "@aprsweb/aprs";
import { hostmodeCommand, parseHostmode, type HostmodeEvent } from "@aprsweb/packet";
import type { Packet } from "@aprsweb/shared";
import type { ParsedFrame } from "@aprsweb/aprs";

export interface HostmodeOpts {
  host: string;
  port: number;
  mycall?: string;
  radioPort?: number;
}
export interface HostmodeHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void;
}

/**
 * WA8DED host-mode TNC client over TCP — a TF-firmware TNC or TFPCX exposed on a socket
 * (the classic serial link is wired at deploy with a serial→TCP bridge or the `serialport` adapter).
 * Enables monitor mode, polls channel 0, and forwards monitored frames as `rf` packets on the
 * `hostmode` port. The wire codec (@aprsweb/packet) is unit-tested; the TNC handshake + the exact
 * monitor-header format are validate-at-deploy.
 */
export class HostmodeTnc {
  private sock?: net.Socket;
  private connected = false;
  private buf = new Uint8Array(0);
  private poll?: ReturnType<typeof setInterval>;
  private pendingHeader: string | null = null;
  constructor(
    private o: HostmodeOpts,
    private h: HostmodeHandlers,
  ) {}

  start() {
    this.connect();
  }

  private send(bytes: Uint8Array) {
    try {
      this.sock?.write(Buffer.from(bytes));
    } catch {
      /* link down */
    }
  }

  private connect() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.on("connect", () => {
      this.connected = true;
      if (this.o.mycall) this.send(hostmodeCommand(0, `I ${this.o.mycall}`)); // set MYCALL (Multiport identity)
      this.send(hostmodeCommand(0, "M UISC")); // monitor UI+I, with callsigns
      this.poll = setInterval(() => {
        if (this.connected) this.send(hostmodeCommand(0, "G"));
      }, 500);
      console.log(`[hostmode] connected ${this.o.host}:${this.o.port}`);
    });
    s.on("data", (chunk: Buffer) => {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      const { events, rest } = parseHostmode(merged);
      this.buf = new Uint8Array(rest);
      for (const ev of events) this.onEvent(ev);
    });
    const down = () => {
      this.connected = false;
      if (this.poll) clearInterval(this.poll);
    };
    s.on("error", () => {
      down();
      console.log("[hostmode] disconnected, retrying…");
    });
    s.on("close", () => {
      down();
      setTimeout(() => this.connect(), 3000);
    });
  }

  /** Turn a monitor header (type 4/5) + info (type 5) into a TNC2 line and decode it. */
  private onEvent(ev: HostmodeEvent): void {
    if (ev.type === 4) {
      this.pendingHeader = ev.text;
      return;
    } // header, info follows separately
    if (ev.type === 5) {
      this.emitMonitor(ev.header, ev.info);
      return;
    }
    if (ev.type === 6 && this.pendingHeader) {
      this.emitMonitor(this.pendingHeader, ev.info);
      this.pendingHeader = null;
    }
  }

  private emitMonitor(header: string, info: Uint8Array): void {
    if (!header.includes(">")) return; // not a parseable addr header
    let body = "";
    for (const b of info) body += String.fromCharCode(b);
    const f = parseTNC2(`${header.trim()}:${body}`);
    if (!f) return;
    this.h.onFrame?.(f);
    this.h.onPacket({
      src: f.src,
      dst: f.dst,
      path: f.path,
      payload: f.payload,
      kind: "other",
      heardVia: "rf",
      port: "hostmode",
      ts: Math.floor(Date.now() / 1000),
      raw: f.raw,
    });
  }
}
