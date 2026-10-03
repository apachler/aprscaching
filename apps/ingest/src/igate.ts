// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { parseTNC2, shouldRxIgate, rxIgateLine, txIgateTarget, txIgateFrame } from "@aprscaching/aprs";
import type { ParsedFrame } from "@aprscaching/aprs";
import type { KissTnc } from "./kiss.js";
import { Backoff } from "./backoff.js";
import { TokenBucket } from "./txlimit.js";
import { LineBuffer } from "./lines.js";
import { SOFTWARE_VERSION } from "./version.js";

export interface IgateOpts {
  host: string;
  port: number;
  call: string;
  pass: string;
  filter?: string; // APRS-IS server-side filter for the IS->RF direction (default messages)
  localTtlSec?: number; // how long a station counts as "heard locally"
  txPath?: string[]; // RF path of gated messages (default none: the addressee was heard locally)
  retryMs?: number;
  idleMs?: number; // destroy a silently-dead uplink after this long with no bytes
  canTx?: () => boolean; // RF-transmit switch for the APRS-IS -> RF direction (absent: never transmits)
  /** Token bucket for the APRS-IS -> RF direction (`IGATE_TX_BURST`, `IGATE_TX_REFILL_SEC`). */
  burst?: number;
  refillSec?: number;
  now?: () => number;
}

const base = (c: string) => c.split("-")[0]!.toUpperCase();

/**
 * Bidirectional APRS IGate over a KISS TNC + an APRS-IS connection.
 *   RX-IGate: RF frames heard on KISS are relayed up to APRS-IS with a qAR construct.
 *   TX-IGate: messages from APRS-IS addressed to a station heard locally on RF are gated to RF.
 * "Heard locally" is tracked from KISS RF receptions. Gating rules are in @aprscaching/aprs (pure).
 */
export class Igate {
  private sock?: net.Socket;
  private ready = false;
  private lines = new LineBuffer();
  private heard = new Map<string, number>(); // base callsign -> last heard ts(ms)
  private localTtl: number;
  private gen = 0; // connection generation — a replaced socket can never reconnect
  private timer?: ReturnType<typeof setTimeout>;
  private backoff: Backoff;
  private sweep?: ReturnType<typeof setInterval>;
  private bucket: TokenBucket;

  constructor(
    private kiss: KissTnc,
    private o: IgateOpts,
  ) {
    this.localTtl = (o.localTtlSec ?? 1800) * 1000;
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
    this.bucket = new TokenBucket({ burst: o.burst ?? 6, refillSec: o.refillSec ?? 10, now: o.now });
  }

  start(): void {
    this.connect();
    // Evict "heard locally" entries past twice the TTL so a months-long uptime doesn't accumulate
    // every callsign ever heard.
    this.sweep = setInterval(() => {
      const cutoff = Date.now() - this.localTtl * 2;
      for (const [cs, t] of this.heard) if (t < cutoff) this.heard.delete(cs);
    }, this.localTtl);
    this.sweep.unref?.();
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

  /**
   * One APRS-IS line for the TX-IGate direction: a message for a station heard locally is gated to RF,
   * paced by the token bucket. A message refused by the bucket is logged and not queued — APRS messaging
   * retries an unacknowledged message itself, so a later retry gets through once a token is back.
   */
  onIsLine(line: string): void {
    const f = parseTNC2(line);
    if (!f) return;
    const addr = txIgateTarget(f, this.o.call, this.heardLocally);
    if (!addr || !(this.o.canTx?.() ?? false)) return;
    if (!this.bucket.take()) {
      console.warn(`[igate] rate limited — message for ${addr} not gated to RF (next in ${this.bucket.waitSec()} s)`);
      return;
    }
    if (this.kiss.send(txIgateFrame(f, this.o.call, { path: this.o.txPath })))
      console.log(`[igate] TX->RF message for ${addr}`);
  }

  /** Write one APRS-IS line; a line holding a CR, LF or NUL is not one line and is dropped. */
  private sendIs(line: string): void {
    if (/[\r\n\0]/.test(line)) return;
    if (this.ready && this.sock) {
      try {
        this.sock.write(line + "\r\n");
      } catch {
        /* dropped */
      }
    }
  }

  /** One reconnect per failure: only `close` schedules (it always follows `error`), stale sockets
   *  and already-scheduled timers are ignored. */
  private retry(gen: number): void {
    if (gen !== this.gen || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.backoff.next()); // exponential backoff + jitter while APRS-IS stays down
  }

  private connect(): void {
    const gen = ++this.gen;
    this.sock?.removeAllListeners();
    this.sock?.destroy();
    this.ready = false;
    this.lines.reset();
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    s.setTimeout(this.o.idleMs ?? 90_000, () => s.destroy()); // detect a silently-dead uplink
    s.on("connect", () => {
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      s.write(
        `user ${this.o.call} pass ${this.o.pass} vers aprscaching-igate ${SOFTWARE_VERSION} filter ${this.o.filter ?? "t/m"}\r\n`,
      );
      this.ready = true;
      console.log("[igate] APRS-IS connected");
    });
    s.on("data", (chunk: string) => {
      for (const line of this.lines.push(chunk)) if (line && !line.startsWith("#")) this.onIsLine(line);
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
