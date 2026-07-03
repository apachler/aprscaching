// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";

/**
 * APRS-IS uplink for publishing announces. Logs in ONCE under the service callsign and relays
 * each user find using THIRD-PARTY format, so the user's callsign stays the inner source:
 *   SERVICE>APZACG,TCPIP*:}USERCALL>APZACG,TCPIP*:>Found AC-1234 via aprscaching.com
 * Requires a service callsign + its APRS-IS passcode (passcode is derived from the callsign).
 */
export class AprsUplink {
  private sock?: net.Socket;
  private ready = false;
  private gen = 0;                    // connection generation — a replaced socket can never reconnect
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private o: { host: string; port: number; serviceCall: string; servicePass: string; retryMs?: number }) {}

  start() { this.connect(); }

  /** One reconnect per failure: only `close` schedules (it always follows `error`), stale sockets
   *  and already-scheduled timers are ignored (SR-ING-01). */
  private retry(gen: number) {
    if (gen !== this.gen || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, this.o.retryMs ?? 3000);
  }

  private connect() {
    const gen = ++this.gen;
    this.sock?.removeAllListeners();
    this.sock?.destroy();
    this.ready = false;
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      s.write(`user ${this.o.serviceCall} pass ${this.o.servicePass} vers aprscaching 0.0\r\n`);
      this.ready = true;
    });
    s.on("error", () => { /* close always follows — reconnect handled there */ });
    s.on("close", () => { this.ready = false; this.retry(gen); });
  }

  /**
   * Publish a queued outbox item via third-party format. kind 'status'|'message'|'wx' — the payload
   * is the full APRS info field (a status `>…`, a message `:…`, or a WX report `!…_…`), so a WX
   * beacon flows through unchanged. The user's callsign stays the inner source.
   */
  publish(item: { src_call: string; tocall: string; payload: string }): boolean {
    if (!this.ready || !this.sock) return false;
    const inner = `${item.src_call}>${item.tocall},TCPIP*:${item.payload}`;
    const frame = `${this.o.serviceCall}>${item.tocall},TCPIP*:}${inner}\r\n`;
    this.sock.write(frame);
    return true;
  }
}
