// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { EventEmitter } from "node:events";
import { Backoff } from "./backoff.js";

export interface AprsIsOpts {
  host: string;
  port: number;
  callsign: string;
  passcode: string;
  filter: string;
  retryMs?: number;
  idleMs?: number; // SR-ING-02: no bytes (not even the server's ~20 s '#' keepalive) for this long ⇒ dead
}

/** Persistent APRS-IS client: connects, logs in with a filter, auto-reconnects, emits lines. */
export class AprsIs extends EventEmitter {
  private sock?: net.Socket;
  private buf = "";
  private gen = 0; // connection generation — a replaced socket can never reconnect
  private timer?: ReturnType<typeof setTimeout>;
  private backoff: Backoff;
  constructor(private o: AprsIsOpts) {
    super();
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
  }

  start() {
    this.connect();
  }

  /** Schedule exactly one reconnect. Only `close` calls this (`close` always follows `error`),
   *  and a stale socket's close is ignored — one failure = one attempt, never a storm (SR-ING-01).
   *  The delay backs off exponentially with jitter while the endpoint stays down (SR-ING-06). */
  private retry(gen: number) {
    if (gen !== this.gen || this.timer) return;
    this.emit("down");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.backoff.next());
  }

  private connect() {
    const gen = ++this.gen;
    this.sock?.removeAllListeners();
    this.sock?.destroy();
    this.buf = ""; // never carry a partial line across connections
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    // SR-ING-02: a half-dead server keeps the TCP session up but stops sending. setTimeout fires when
    // no bytes arrive within idleMs (reset on every read) → destroy → `close` → one reconnect.
    s.setTimeout(this.o.idleMs ?? 90_000, () => s.destroy());
    s.on("connect", () => {
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      s.write(`user ${this.o.callsign} pass ${this.o.passcode} vers aprscaching 0.0 filter ${this.o.filter}\r\n`);
      this.emit("up");
    });
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        if (line && !line.startsWith("#")) this.emit("line", line);
      }
    });
    s.on("error", () => {
      /* close always follows — reconnect handled there */
    });
    s.on("close", () => this.retry(gen));
  }
}
