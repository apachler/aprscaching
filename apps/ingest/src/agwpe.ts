import net from "node:net";
import { decodeAx25, encodeAx25 } from "@aprsweb/aprs";
import { parseAgwpe, encodeAgwpe } from "@aprsweb/packet";
import type { Packet } from "@aprsweb/shared";
import type { ParsedFrame } from "@aprsweb/aprs";

export interface AgwpeOpts { host: string; port: number; radioPort?: number }
export interface AgwpeHandlers { onPacket: (p: Packet) => void; onFrame?: (f: ParsedFrame) => void }

/**
 * AGWPE TCP client (docs/27 B.1) — connects to an AGW Packet Engine (Direwolf/SoundModem/UZ7HO on
 * :8000), enables raw-frame monitoring, and forwards each heard AX.25 frame as an `rf` packet on the
 * `agwpe` port. send() keys the modem with a raw AX.25 frame. The wire codec (@aprsweb/packet) is
 * unit-tested; the engine handshake + frame semantics are validate-at-deploy against a real engine.
 */
export class AgwpeTnc {
  private sock?: net.Socket;
  private connected = false;
  private buf = new Uint8Array(0);
  constructor(private o: AgwpeOpts, private h: AgwpeHandlers) {}

  start() { this.connect(); }

  /** Transmit a raw AX.25 frame via AGWPE 'K' (RawAX25). Best-effort. */
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean {
    if (!this.connected || !this.sock) return false;
    // 'K' data is [radioPort byte][raw AX.25 frame] in AGWPE's raw-send convention.
    const ax = encodeAx25(f);
    const data = new Uint8Array(1 + ax.length);
    data[0] = this.o.radioPort ?? 0;
    data.set(ax, 1);
    try { this.sock.write(Buffer.from(encodeAgwpe({ port: this.o.radioPort ?? 0, kind: "K", from: f.src, to: f.dst, data }))); return true; }
    catch { return false; }
  }

  private connect() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.on("connect", () => {
      this.connected = true;
      // register the app ('X'), enable raw-frame monitor ('k') on our radio port
      s.write(Buffer.from(encodeAgwpe({ port: this.o.radioPort ?? 0, kind: "X" })));
      s.write(Buffer.from(encodeAgwpe({ port: this.o.radioPort ?? 0, kind: "k" })));
      console.log(`[agwpe] connected ${this.o.host}:${this.o.port}`);
    });
    s.on("data", (chunk: Buffer) => {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      const { frames, rest } = parseAgwpe(merged);
      this.buf = new Uint8Array(rest);   // copy into a fresh ArrayBuffer-backed view
      for (const fr of frames) {
        if (fr.kind !== "K") continue;                 // raw AX.25 monitor frames only
        const ax = fr.data.length > 1 ? fr.data.slice(1) : fr.data; // strip the leading radio-port byte
        const f = decodeAx25(ax);
        if (!f) continue;
        this.h.onFrame?.(f);
        this.h.onPacket({
          src: f.src, dst: f.dst, path: f.path, payload: f.payload,
          kind: "other", heardVia: "rf", port: "agwpe",
          ts: Math.floor(Date.now() / 1000), raw: f.raw,
        });
      }
    });
    const down = () => { this.connected = false; };
    s.on("error", () => { down(); console.log("[agwpe] disconnected, retrying…"); });
    s.on("close", () => { down(); setTimeout(() => this.connect(), 3000); });
  }
}
