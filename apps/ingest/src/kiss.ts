// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import {
  KissDecoder,
  KISS_TIMING_DEFAULTS,
  kissStripCrc,
  kissTimingFrames,
  kissWrap,
  decodeAx25,
  encodeAx25,
  type KissTiming,
} from "@aprscaching/aprs";
import { decodeFrame, encodeFrame, type Ax25Frame } from "@aprscaching/ax25";
import type { Packet } from "@aprscaching/shared";
import type { KissFrame, ParsedFrame } from "@aprscaching/aprs";
import { Backoff } from "./backoff.js";
import { numEnv } from "./config.js";
import { tncPacket } from "./link.js";
import type { SentFrames } from "./echo.js";

export interface KissOpts {
  host: string;
  port: number;
  retryMs?: number;
  /** This box's receiving-site callsign; stamped on frames heard directly (see {@link directSiteCall}). */
  siteCall?: string;
  /** The frames the box sent on any port: what this TNC sends is remembered there, and an echo of one is dropped. */
  sent?: SentFrames;
  /** The channel access sent to the TNC after each connect; absent, the TNC keeps its own (see {@link kissTimingFromEnv}). */
  timing?: KissTiming | null;
}

/**
 * The TXDELAY, PERSIST and SLOTTIME the box sends its KISS TNC after each connect: `KISS_TXDELAY`, `KISS_PERSIST`
 * and `KISS_SLOTTIME` (0–255; the APRS values of {@link KISS_TIMING_DEFAULTS} unless set), or null with
 * `KISS_TIMING=off`, which leaves the TNC on what its own configuration sets (a `direwolf.conf`, a TNC's firmware).
 */
export function kissTimingFromEnv(env: Record<string, string | undefined> = process.env): KissTiming | null {
  const mode = (env.KISS_TIMING ?? "").trim().toLowerCase();
  if (mode === "off") return null;
  if (mode !== "" && mode !== "on")
    console.warn('[config] KISS_TIMING="%s" is neither on nor off — sending the timing', env.KISS_TIMING);
  const byte = (key: string, def: number) => Math.round(numEnv(key, def, { min: 0, max: 255 }, env));
  return {
    txDelay: byte("KISS_TXDELAY", KISS_TIMING_DEFAULTS.txDelay),
    persist: byte("KISS_PERSIST", KISS_TIMING_DEFAULTS.persist),
    slotTime: byte("KISS_SLOTTIME", KISS_TIMING_DEFAULTS.slotTime),
  };
}

/** Pointed at a non-KISS port a frame's terminating FEND never arrives and the partial frame would grow
 *  forever. Bound it — past this many bytes with no complete frame the stream isn't KISS; drop it. */
const KISS_RX_MAX_BYTES = 64 * 1024;

/**
 * A MeshCom node's KISS port: the node renders LoRa frames as AX.25 to its tocall `APRSMC`, and answers each
 * frame it is sent with a result on KISS port 15. Its frames are not this box's RF hearings: a frame the
 * MeshCom server relayed, or the node's own, arrives with an empty path and would read as heard directly.
 */
export const isMeshcomNode = (k: { port: number; frame: Uint8Array }, dst: string | undefined) =>
  k.port === 15 || (dst !== undefined && /^APRSMC(-\d+)?$/i.test(dst));
export interface KissHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void; // UI-decoded RF frame (for the APRS digipeater / igate)
  onRaw?: (bytes: Uint8Array) => void; // raw KISS-unwrapped AX.25 frame (for connected-mode: node/digi)
  onInvalid?: () => void; // a data frame that is no AX.25 frame at all, for the port's health
}

export interface TcpLinkOpts {
  host: string;
  port: number;
  retryMs?: number;
  /** The log prefix, such as `kiss` or `lora-aprs`. */
  tag: string;
}

/**
 * A TCP client to a local device (a TNC, a modem) that reconnects with backoff and keeps the connection probed.
 * It hands each read on as it arrives; what the stream holds is the caller's business.
 */
export class TcpLink {
  sock?: net.Socket;
  connected = false;
  private backoff: Backoff;
  private stopped = false;
  constructor(
    private o: TcpLinkOpts,
    private h: { onChunk: (chunk: Buffer) => void; onOpen?: () => void; onConnect?: () => void },
  ) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.sock?.destroy();
  }

  /** Write bytes to the device; false while the link is down. */
  write(bytes: Uint8Array): boolean {
    if (!this.connected || !this.sock) return false;
    this.sock.write(bytes);
    return true;
  }

  private connect() {
    if (this.stopped) return;
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    // A quiet channel sends nothing for hours, so silence proves nothing; TCP keepalive probes find a device
    // host that vanished (power cut, Wi-Fi drop) and close the socket, which reconnects.
    s.setKeepAlive(true, 30_000);
    this.h.onOpen?.(); // a new connection never continues the old one's partial frame
    s.on("connect", () => {
      this.connected = true;
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      console.log("[%s] connected %s:%s", this.o.tag, this.o.host, this.o.port);
      this.h.onConnect?.(); // written here, ahead of anything else sent on this connection
    });
    s.on("data", (chunk: Buffer) => this.h.onChunk(chunk));
    const down = () => {
      this.connected = false;
    };
    s.on("error", () => {
      down();
      console.log("[%s] disconnected, retrying…", this.o.tag);
    });
    s.on("close", () => {
      down();
      if (!this.stopped) setTimeout(() => this.connect(), this.backoff.next()); // backoff + jitter
    });
  }
}

/**
 * A KISS-over-TCP connection: reassembles KISS frames across reads, strips a SMACK or FlexNet CRC, and hands
 * each data frame on with its KISS port. What a frame holds is the caller's business: AX.25 for a TNC, a LoRa
 * packet for a LoRa APRS modem.
 */
export class KissLink {
  readonly tcp: TcpLink;
  private rx = new KissDecoder(KISS_RX_MAX_BYTES);
  constructor(
    private o: TcpLinkOpts,
    private onData: (k: KissFrame) => void,
    onConnect?: () => void,
  ) {
    this.tcp = new TcpLink(o, { onChunk: (c) => this.onChunk(c), onOpen: () => this.rx.reset(), onConnect });
  }

  start(): void {
    this.tcp.start();
  }

  stop(): void {
    this.tcp.stop();
  }

  write(bytes: Uint8Array): boolean {
    return this.tcp.write(bytes);
  }

  private onChunk(chunk: Buffer): void {
    const overflows = this.rx.overflows;
    const frames = this.rx.push(chunk);
    if (this.rx.overflows !== overflows)
      console.warn(
        "[%s] RX frame over %s bytes with no closing FEND — not KISS? dropped",
        this.o.tag,
        KISS_RX_MAX_BYTES,
      );
    for (const crcd of frames) {
      // a KISS host such as the Linux kernel's mkiss opens with SMACK and FlexNet CRC probes
      const k = kissStripCrc(crcd);
      if (!k || k.command !== 0) continue; // a failed CRC, or a KISS command rather than a frame
      this.onData(k);
    }
  }
}

/**
 * KISS-over-TCP TNC client (e.g. Direwolf on :8001). Decodes each frame as AX.25, forwards each UI frame as
 * an `rf`-heard packet on the `kiss-tnc` port, and exposes send() so a digipeater / TX-IGate can transmit.
 * Auto-reconnects, and sends the TNC its channel access (`timing`) after each connect: a TNC that restarted is
 * back on its own defaults. The three command frames key nothing, so they go out whether or not the box transmits.
 */
export class KissTnc {
  private link: KissLink;
  constructor(
    private o: KissOpts,
    private h: KissHandlers,
  ) {
    this.link = new KissLink(
      { host: o.host, port: o.port, retryMs: o.retryMs, tag: "kiss" },
      (k) => this.onData(k),
      () => this.sendTiming(),
    );
  }

  private sendTiming(): void {
    const t = this.o.timing;
    if (!t) return;
    this.link.write(kissTimingFrames(t));
    console.log("[kiss] sent TXDELAY %s, PERSIST %s, SLOTTIME %s", t.txDelay, t.persist, t.slotTime);
  }

  private get sock(): net.Socket | undefined {
    return this.link.tcp.sock;
  }

  private get connected(): boolean {
    return this.link.tcp.connected;
  }

  start() {
    this.link.start();
  }

  /** Set once the TNC turned out to be a MeshCom node: nothing more is forwarded or sent through it. */
  private meshcomNode = false;

  /** Transmit an AX.25 UI frame over KISS (best-effort; dropped if the TNC link is down). */
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean {
    if (!this.connected || !this.sock || this.meshcomNode) return false;
    try {
      const raw = encodeAx25(f);
      this.link.write(kissWrap(raw));
      this.o.sent?.remember(raw);
      return true;
    } catch {
      return false;
    }
  }

  /** Transmit a full AX.25 frame (any type — for connected-mode: NET/ROM node, connected digi). */
  sendFrame(f: Ax25Frame): boolean {
    if (!this.connected || !this.sock || this.meshcomNode) return false;
    try {
      const raw = encodeFrame(f);
      this.link.write(kissWrap(raw));
      this.o.sent?.remember(raw);
      return true;
    } catch {
      return false;
    }
  }

  private onData(k: KissFrame): void {
    const raw = k.frame;
    const f = decodeAx25(raw);
    if (!this.meshcomNode && isMeshcomNode(k, f?.dst)) {
      this.meshcomNode = true;
      console.error(
        "[kiss] %s:%s is a MeshCom node, not a TNC: its frames are ignored and nothing is sent through it. Listen to the node with MESHCOM_NODE instead.",
        this.o.host,
        this.o.port,
      );
    }
    if (this.meshcomNode) return;
    if (this.o.sent?.echoes(raw)) return; // the box's own transmission, heard back
    this.h.onRaw?.(raw); // raw AX.25 for connected-mode consumers (node/digi)
    if (!f) {
      // a connected-mode frame is AX.25 but no APRS packet; only a frame no decoder reads counts as invalid
      if (!decodeFrame(raw)) this.h.onInvalid?.();
      return;
    }
    this.h.onFrame?.(f);
    this.h.onPacket(tncPacket(f, "kiss-tnc", this.o.siteCall, Math.floor(Date.now() / 1000)));
  }
}
