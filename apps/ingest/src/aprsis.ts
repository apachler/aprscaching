// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { EventEmitter } from "node:events";
import { Backoff } from "./backoff.js";
import { LineBuffer } from "./lines.js";
import { SOFTWARE_VERSION } from "./version.js";

export interface AprsIsOpts {
  host: string;
  port: number;
  callsign: string;
  passcode: string;
  filter: string;
  retryMs?: number;
  idleMs?: number; // no bytes (not even the server's ~20 s '#' keepalive) for this long ⇒ dead
}

/** Persistent APRS-IS client: connects, logs in with a filter, auto-reconnects, emits lines. */
export class AprsIs extends EventEmitter {
  private sock?: net.Socket;
  private lines = new LineBuffer();
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

  /** The gateway's service call: messages addressed to it are radio commands, wherever their sender is. */
  private serviceCall?: string;

  /** The login filter: the configured one, plus a group-message filter for the service call. */
  private filter(): string {
    return this.serviceCall ? `${this.o.filter} g/${this.serviceCall}`.trim() : this.o.filter;
  }

  /**
   * Ask for messages addressed to the service call too. A range filter passes stations near a point, so a
   * command sent from further away would never arrive without it. A live connection takes the new filter at
   * once (`#filter`), a later one at login.
   */
  setServiceCall(call: string) {
    const c = call.trim().toUpperCase();
    if (!c || c === this.serviceCall) return;
    this.serviceCall = c;
    const s = this.sock;
    if (s && s.writable && !s.destroyed) s.write(`#filter ${this.filter()}\r\n`);
  }

  /** Schedule exactly one reconnect. Only `close` calls this (`close` always follows `error`),
   *  and a stale socket's close is ignored — one failure = one attempt, never a storm.
   *  The delay backs off exponentially with jitter while the endpoint stays down. */
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
    this.lines.reset(); // never carry a partial line across connections
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    // A half-dead server keeps the TCP session up but stops sending. setTimeout fires when
    // no bytes arrive within idleMs (reset on every read) → destroy → `close` → one reconnect.
    s.setTimeout(this.o.idleMs ?? 90_000, () => s.destroy());
    s.on("connect", () => {
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      s.write(
        `user ${this.o.callsign} pass ${this.o.passcode} vers aprscaching ${SOFTWARE_VERSION} filter ${this.filter()}\r\n`,
      );
      this.emit("up");
    });
    s.on("data", (chunk: string) => {
      for (const line of this.lines.push(chunk)) if (line && !line.startsWith("#")) this.emit("line", line);
    });
    s.on("error", () => {
      /* close always follows — reconnect handled there */
    });
    s.on("close", () => this.retry(gen));
  }
}
