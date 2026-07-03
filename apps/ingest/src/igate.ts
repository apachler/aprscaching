// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { parseTNC2, shouldRxIgate, rxIgateLine, txIgateTarget } from "@aprsweb/aprs";
import type { ParsedFrame } from "@aprsweb/aprs";
import type { KissTnc } from "./kiss.js";

export interface IgateOpts {
  host: string;
  port: number;
  call: string;
  pass: string;
  filter?: string; // APRS-IS server-side filter for the IS->RF direction (default messages)
  localTtlSec?: number; // how long a station counts as "heard locally"
  retryMs?: number;
  idleMs?: number; // SR-ING-02: destroy a silently-dead uplink after this long with no bytes
}

const base = (c: string) => c.split("-")[0]!.toUpperCase();

/**
 * Bidirectional APRS IGate over a KISS TNC + an APRS-IS connection.
 *   RX-IGate: RF frames heard on KISS are relayed up to APRS-IS with a qAR construct.
 *   TX-IGate: messages from APRS-IS addressed to a station heard locally on RF are gated to RF.
 * "Heard locally" is tracked from KISS RF receptions. Gating rules are in @aprsweb/aprs (pure).
 */
export class Igate {
  private sock?: net.Socket;
  private ready = false;
  private buf = "";
  private heard = new Map<string, number>(); // base callsign -> last heard ts(ms)
  private localTtl: number;
  private gen = 0; // connection generation — a replaced socket can never reconnect
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private kiss: KissTnc,
    private o: IgateOpts,
  ) {
    this.localTtl = (o.localTtlSec ?? 1800) * 1000;
  }

  start(): void {
    this.connect();
  }

  /** Called for every RF frame heard via KISS. */
  onRf(f: ParsedFrame): void {
    this.heard.set(base(f.src), Date.now());
    if (shouldRxIgate(f, this.o.call)) this.sendIs(rxIgateLine(f, this.o.call));
  }

  private heardLocally = (cs: string): boolean => {
    const t = this.heard.get(base(cs));
    return !!t && Date.now() - t < this.localTtl;
  };

  private sendIs(line: string): void {
    if (this.ready && this.sock) {
      try {
        this.sock.write(line + "\r\n");
      } catch {
        /* dropped */
      }
    }
  }

  /** One reconnect per failure: only `close` schedules (it always follows `error`), stale sockets
   *  and already-scheduled timers are ignored (SR-ING-01). */
  private retry(gen: number): void {
    if (gen !== this.gen || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.o.retryMs ?? 3000);
  }

  private connect(): void {
    const gen = ++this.gen;
    this.sock?.removeAllListeners();
    this.sock?.destroy();
    this.ready = false;
    this.buf = "";
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    s.setTimeout(this.o.idleMs ?? 90_000, () => s.destroy()); // SR-ING-02: detect a silently-dead uplink
    s.on("connect", () => {
      s.write(
        `user ${this.o.call} pass ${this.o.pass} vers aprscaching-igate 0.0 filter ${this.o.filter ?? "t/m"}\r\n`,
      );
      this.ready = true;
      console.log("[igate] APRS-IS connected");
    });
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        if (!line || line.startsWith("#")) continue;
        const f = parseTNC2(line);
        if (!f) continue;
        const addr = txIgateTarget(f, this.o.call, this.heardLocally);
        if (addr && this.kiss.send({ src: f.src, dst: f.dst, path: [`${this.o.call}*`], payload: f.payload }))
          console.log(`[igate] TX->RF message for ${addr}`);
      }
    });
    s.on("error", () => {
      /* close always follows — reconnect handled there */
    });
    s.on("close", () => {
      this.ready = false;
      this.retry(gen);
    });
  }
}
