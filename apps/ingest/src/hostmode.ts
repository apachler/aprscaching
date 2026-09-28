// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { parseTNC2 } from "@aprscaching/aprs";
import { hostmodeCommand, parseHostmode } from "@aprscaching/packet";
import type { Packet } from "@aprscaching/shared";
import type { ParsedFrame } from "@aprscaching/aprs";
import { Backoff } from "./backoff.js";
import { tncPacket } from "./link.js";

/** A stream that holds more than this without completing a host-mode frame is not a WA8DED TNC. */
export const HOSTMODE_RX_MAX_BYTES = 64 * 1024;

export interface HostmodeOpts {
  host: string;
  port: number;
  mycall?: string;
  radioPort?: number;
  /** This box's receiving-site callsign; stamped on frames heard directly (see `directSiteCall`). */
  siteCall?: string;
  /** Base reconnect delay (default 3000 ms); grows with backoff while the TNC stays unreachable. */
  retryMs?: number;
}

/**
 * A monitor header as a TNC2 address field (`SRC>DST,DIGI*,…`). TheFirmware / WA8DED TNCs print
 * `fm SRC to DST via DIGI* DIGI ctl UI^ pid F0`; a header already in TNC2 form passes through. The
 * has-been-repeated `*` on a digipeater hop is kept, which is what the direct-hearing site stamp reads.
 * Returns null for anything that is neither form.
 */
export function monitorHeaderToTnc2(header: string): string | null {
  const h = header.trim();
  if (h.includes(">")) return h;
  const m = /^fm\s+(\S+)\s+to\s+(\S+)(?:\s+via\s+(.+?))?(?:\s+(?:ctl|pid)\b.*)?$/i.exec(h);
  if (!m) return null;
  const via = m[3] ? m[3].trim().split(/\s+/) : [];
  return [`${m[1]}>${m[2]}`, ...via].join(",");
}

/** The ingest packet for one monitored frame (header + info), or null when the header is not parseable. */
export function hostmodeMonitorPacket(
  header: string,
  info: Uint8Array,
  siteCall: string | undefined,
  ts: number,
): { frame: ParsedFrame; packet: Packet } | null {
  const addr = monitorHeaderToTnc2(header);
  if (!addr) return null;
  let body = "";
  for (const b of info) body += String.fromCharCode(b);
  const frame = parseTNC2(`${addr}:${body}`);
  if (!frame) return null;
  return { frame, packet: tncPacket(frame, "hostmode", siteCall, ts) };
}
/**
 * The host-mode receive side: reassembles frames split across TCP chunks (bounded by
 * {@link HOSTMODE_RX_MAX_BYTES}) and pairs each type-5 monitor header with the type-6 info block that
 * immediately follows it. Any other event in between — a type-4 header of a frame without info, a status
 * or success response — clears the pending header, so one station's header is never joined to another
 * station's info, and a type-6 block with no header right before it is dropped. A type-4 frame carries
 * no APRS payload and yields nothing.
 */
export class HostmodeRx {
  private buf = new Uint8Array(0);
  private pendingHeader: string | null = null;

  /** Monitored frames completed by `chunk`, or null when the stream is not host mode. */
  push(chunk: Uint8Array): { header: string; info: Uint8Array }[] | null {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const { events, rest } = parseHostmode(merged);
    if (rest.length > HOSTMODE_RX_MAX_BYTES) {
      this.reset();
      return null;
    }
    this.buf = new Uint8Array(rest);
    const out: { header: string; info: Uint8Array }[] = [];
    for (const ev of events) {
      const header = this.pendingHeader;
      this.pendingHeader = null;
      if (ev.type === 5) this.pendingHeader = ev.text;
      else if (ev.type === 6 && header !== null) out.push({ header, info: ev.info });
    }
    return out;
  }

  /** Forget buffered bytes and any pending header (a new connection starts clean). */
  reset(): void {
    this.buf = new Uint8Array(0);
    this.pendingHeader = null;
  }

  get buffered(): number {
    return this.buf.length;
  }
}

export interface HostmodeHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void;
}

/**
 * WA8DED host-mode TNC client over TCP — a TF-firmware TNC or TFPCX exposed on a socket
 * (the classic serial link is wired at deploy with a serial→TCP bridge or the `serialport` adapter).
 * Enables monitor mode, polls channel 0, and forwards monitored frames as `rf` packets on the
 * `hostmode` port. The wire codec (@aprscaching/packet) is unit-tested; the TNC handshake + the exact
 * monitor-header format are validate-at-deploy.
 */
export class HostmodeTnc {
  private sock?: net.Socket;
  private connected = false;
  private rx = new HostmodeRx();
  private poll?: ReturnType<typeof setInterval>;
  private backoff: Backoff;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private o: HostmodeOpts,
    private h: HostmodeHandlers,
  ) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.sock?.destroy();
  }

  private send(bytes: Uint8Array) {
    try {
      this.sock?.write(Buffer.from(bytes));
    } catch {
      /* link down */
    }
  }

  private connect() {
    if (this.stopped) return;
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    this.rx.reset(); // never carry a partial frame or a pending header across a reconnect
    s.on("connect", () => {
      this.connected = true;
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      if (this.o.mycall) this.send(hostmodeCommand(0, `I ${this.o.mycall}`)); // set MYCALL (Multiport identity)
      this.send(hostmodeCommand(0, "M UISC")); // monitor UI+I, with callsigns
      if (this.poll) clearInterval(this.poll);
      this.poll = setInterval(() => {
        if (this.connected) this.send(hostmodeCommand(0, "G"));
      }, 500);
      console.log(`[hostmode] connected ${this.o.host}:${this.o.port}`);
    });
    s.on("data", (chunk: Buffer) => {
      const monitored = this.rx.push(chunk);
      if (!monitored) {
        console.warn(
          `[hostmode] RX buffer over ${HOSTMODE_RX_MAX_BYTES} bytes with no frame — not host mode? reconnecting`,
        );
        s.destroy();
        return;
      }
      for (const m of monitored) this.emitMonitor(m.header, m.info);
    });
    const down = () => {
      this.connected = false;
      if (this.poll) clearInterval(this.poll);
      this.poll = undefined;
    };
    s.on("error", () => {
      down();
      console.log("[hostmode] disconnected, retrying…");
    });
    s.on("close", () => {
      down();
      if (this.stopped || this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.connect();
      }, this.backoff.next()); // backoff + jitter
    });
  }

  private emitMonitor(header: string, info: Uint8Array): void {
    const r = hostmodeMonitorPacket(header, info, this.o.siteCall, Math.floor(Date.now() / 1000));
    if (!r) return;
    this.h.onFrame?.(r.frame);
    this.h.onPacket(r.packet);
  }
}
