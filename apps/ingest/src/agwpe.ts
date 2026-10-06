// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { decodeAx25, encodeAx25 } from "@aprscaching/aprs";
import { parseAgwpe, encodeAgwpe, type AgwpeFrame } from "@aprscaching/packet";
import type { Packet } from "@aprscaching/shared";
import type { ParsedFrame } from "@aprscaching/aprs";
import { Backoff } from "./backoff.js";
import { tncPacket } from "./link.js";
import type { SentFrames } from "./echo.js";

/** The largest frame payload accepted. A monitored AX.25 frame is a few hundred bytes; a header declaring
 *  more than this is not an AGW Packet Engine talking, and waiting for its data would buffer without end. */
export const AGWPE_MAX_DATA = 64 * 1024;
const AGWPE_HEADER = 36;

/**
 * The AGWPE receive buffer: reassembles frames split across TCP chunks and stays bounded — it never holds
 * more than one partial frame, and a frame declaring more than {@link AGWPE_MAX_DATA} is refused.
 */
export class AgwpeRx {
  private buf = new Uint8Array(0);

  /** Complete frames in `chunk` (plus what was held back), or null when the stream is not AGWPE. */
  push(chunk: Uint8Array): AgwpeFrame[] | null {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const { frames, rest } = parseAgwpe(merged);
    const declared = rest.length >= AGWPE_HEADER ? new DataView(rest.buffer, rest.byteOffset).getUint32(28, true) : 0;
    if (declared > AGWPE_MAX_DATA || rest.length > AGWPE_HEADER + AGWPE_MAX_DATA) {
      this.reset();
      return null;
    }
    this.buf = new Uint8Array(rest); // copy into a fresh ArrayBuffer-backed view
    return frames;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }

  get buffered(): number {
    return this.buf.length;
  }
}

export interface AgwpeOpts {
  /** This box's receiving-site callsign; stamped on frames heard directly (see `directSiteCall`). */
  siteCall?: string;
  host: string;
  port: number;
  radioPort?: number;
  /** Base reconnect delay (default 3000 ms); grows with backoff while the engine stays unreachable. */
  retryMs?: number;
  /** The frames the box sent on its other ports: an echo of one heard here is dropped. */
  sent?: SentFrames;
}
export interface AgwpeHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void;
}

/**
 * AGWPE TCP client — connects to an AGW Packet Engine (Direwolf/SoundModem/UZ7HO on
 * :8000), enables raw-frame monitoring, and forwards each heard AX.25 frame as an `rf` packet on the
 * `agwpe` port. send() keys the modem with a raw AX.25 frame. The wire codec (@aprscaching/packet) is
 * unit-tested; the engine handshake and frame semantics are asserted against Direwolf in the weekly
 * `transports` workflow (`tools/interop/tests/direwolf-loop.mjs`).
 */
export class AgwpeTnc {
  private sock?: net.Socket;
  private connected = false;
  private rx = new AgwpeRx();
  private backoff: Backoff;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private o: AgwpeOpts,
    private h: AgwpeHandlers,
  ) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.sock?.destroy();
  }

  /** Transmit a raw AX.25 frame via AGWPE 'K' (RawAX25). Best-effort. */
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean {
    if (!this.connected || !this.sock) return false;
    // 'K' data is [radioPort byte][raw AX.25 frame] in AGWPE's raw-send convention.
    const ax = encodeAx25(f);
    const data = new Uint8Array(1 + ax.length);
    data[0] = this.o.radioPort ?? 0;
    data.set(ax, 1);
    try {
      this.sock.write(
        Buffer.from(encodeAgwpe({ port: this.o.radioPort ?? 0, kind: "K", from: f.src, to: f.dst, data })),
      );
      this.o.sent?.remember(ax);
      return true;
    } catch {
      return false;
    }
  }

  private connect() {
    if (this.stopped) return;
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    this.rx.reset(); // never carry a partial frame across a reconnect
    s.on("connect", () => {
      this.connected = true;
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      // register the app ('X'), enable raw-frame monitor ('k') on our radio port
      s.write(Buffer.from(encodeAgwpe({ port: this.o.radioPort ?? 0, kind: "X" })));
      s.write(Buffer.from(encodeAgwpe({ port: this.o.radioPort ?? 0, kind: "k" })));
      console.log("[agwpe] connected %s:%s", this.o.host, this.o.port);
    });
    s.on("data", (chunk: Buffer) => {
      const frames = this.rx.push(chunk);
      if (!frames) {
        console.warn("[agwpe] frame over %s bytes — not an AGW Packet Engine? reconnecting", AGWPE_MAX_DATA);
        s.destroy();
        return;
      }
      for (const fr of frames) {
        if (fr.kind !== "K") continue; // raw AX.25 monitor frames only
        const ax = fr.data.length > 1 ? fr.data.slice(1) : fr.data; // strip the leading radio-port byte
        if (this.o.sent?.echoes(ax)) continue; // the box's own transmission, heard back
        const f = decodeAx25(ax);
        if (!f) continue;
        this.h.onFrame?.(f);
        this.h.onPacket(tncPacket(f, "agwpe", this.o.siteCall, Math.floor(Date.now() / 1000)));
      }
    });
    const down = () => {
      this.connected = false;
    };
    s.on("error", () => {
      down();
      console.log("[agwpe] disconnected, retrying…");
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
}
