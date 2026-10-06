// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { KissDecoder, kissStripCrc, kissWrap, decodeAx25, encodeAx25 } from "@aprscaching/aprs";
import { encodeFrame, type Ax25Frame } from "@aprscaching/ax25";
import type { Packet } from "@aprscaching/shared";
import type { ParsedFrame } from "@aprscaching/aprs";
import { Backoff } from "./backoff.js";
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
}

/** Pointed at a non-KISS port a frame's terminating FEND never arrives and the partial frame would grow
 *  forever. Bound it — past this many bytes with no complete frame the stream isn't KISS; drop it. */
const KISS_RX_MAX_BYTES = 64 * 1024;

/**
 * A MeshCom node's KISS port: the node renders LoRa frames as AX.25 to its tocall `APRSMC`, and answers each
 * frame it is sent with a result on KISS port 15. Its frames are not this box's RF hearings: a frame the
 * MeshCom server relayed, or the node's own, arrives with an empty path and would read as heard directly.
 */
const isMeshcomNode = (k: { port: number; frame: Uint8Array }, dst: string | undefined) =>
  k.port === 15 || (dst !== undefined && /^APRSMC(-\d+)?$/i.test(dst));
export interface KissHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void; // UI-decoded RF frame (for the APRS digipeater / igate)
  onRaw?: (bytes: Uint8Array) => void; // raw KISS-unwrapped AX.25 frame (for connected-mode: node/digi)
}

/**
 * KISS-over-TCP TNC client (e.g. Direwolf on :8001). Reassembles KISS frames, decodes the AX.25
 * UI frame, forwards each as an `rf`-heard packet on the `kiss-tnc` port, and exposes send() so a
 * digipeater / TX-IGate can transmit. Auto-reconnects.
 */
export class KissTnc {
  private sock?: net.Socket;
  private connected = false;
  private rx = new KissDecoder(KISS_RX_MAX_BYTES);
  private backoff: Backoff;
  constructor(
    private o: KissOpts,
    private h: KissHandlers,
  ) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
  }

  start() {
    this.connect();
  }

  /** Set once the TNC turned out to be a MeshCom node: nothing more is forwarded or sent through it. */
  private meshcomNode = false;

  /** Transmit an AX.25 UI frame over KISS (best-effort; dropped if the TNC link is down). */
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean {
    if (!this.connected || !this.sock || this.meshcomNode) return false;
    try {
      const raw = encodeAx25(f);
      this.sock.write(kissWrap(raw));
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
      this.sock.write(kissWrap(raw));
      this.o.sent?.remember(raw);
      return true;
    } catch {
      return false;
    }
  }

  private connect() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    // A quiet channel sends nothing for hours, so silence proves nothing; TCP keepalive probes find a TNC
    // host that vanished (power cut, Wi-Fi drop) and close the socket, which reconnects.
    s.setKeepAlive(true, 30_000);
    this.rx.reset(); // never carry a partial frame across a reconnect
    s.on("connect", () => {
      this.connected = true;
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      console.log(`[kiss] connected ${this.o.host}:${this.o.port}`);
    });
    s.on("data", (chunk: Buffer) => {
      const overflows = this.rx.overflows;
      const frames = this.rx.push(chunk);
      if (this.rx.overflows !== overflows)
        console.warn(`[kiss] RX frame over ${KISS_RX_MAX_BYTES} bytes with no closing FEND — not KISS? dropped`);
      for (const crcd of frames) {
        // a KISS host such as the Linux kernel's mkiss opens with SMACK and FlexNet CRC probes
        const k = kissStripCrc(crcd);
        if (!k || k.command !== 0) continue; // a failed CRC, or a KISS command rather than a frame
        const raw = k.frame;
        const f = decodeAx25(raw);
        if (!this.meshcomNode && isMeshcomNode(k, f?.dst)) {
          this.meshcomNode = true;
          console.error(
            `[kiss] ${this.o.host}:${this.o.port} is a MeshCom node, not a TNC: its frames are ignored and nothing is sent through it. Listen to the node with MESHCOM_NODE instead.`,
          );
        }
        if (this.meshcomNode) continue;
        if (this.o.sent?.echoes(raw)) continue; // the box's own transmission, heard back
        this.h.onRaw?.(raw); // raw AX.25 for connected-mode consumers (node/digi)
        if (!f) continue;
        this.h.onFrame?.(f);
        this.h.onPacket(tncPacket(f, "kiss-tnc", this.o.siteCall, Math.floor(Date.now() / 1000)));
      }
    });
    const down = () => {
      this.connected = false;
    };
    s.on("error", () => {
      down();
      console.log("[kiss] disconnected, retrying…");
    });
    s.on("close", () => {
      down();
      setTimeout(() => this.connect(), this.backoff.next()); // backoff + jitter
    });
  }
}
