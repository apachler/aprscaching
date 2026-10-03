// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { Backoff } from "./backoff.js";

const baseOf = (c: string) => (c.toUpperCase().split("-")[0] ?? "").trim();

/**
 * The uplink's APRS-IS login. `APRSIS_SERVICE_CALL` with `APRSIS_SERVICE_PASS` when set; otherwise the
 * gateway's service call, with this box's feed passcode when the feed logs in under the same base call (a
 * passcode belongs to a base call and serves every SSID). A box of another operator, or one with no passcode,
 * publishes nothing: answers from a base call it does not hold would go out as third-party traffic, which
 * IGates do not gate to RF.
 */
export function uplinkLogin(o: {
  serviceCall?: string;
  explicitCall?: string;
  explicitPass?: string;
  feedCall?: string;
  feedPass?: string;
}): { call: string; pass: string } | { reason: string } {
  if (o.explicitCall && o.explicitPass) return { call: o.explicitCall.toUpperCase(), pass: o.explicitPass };
  if (!o.serviceCall) return { reason: "the gateway has not named its service call" };
  if (!o.feedCall || baseOf(o.feedCall) !== baseOf(o.serviceCall))
    return { reason: `APRSIS_CALLSIGN is not a call of ${baseOf(o.serviceCall)}, the service call's base call` };
  if (!o.feedPass || !/^\d{1,5}$/.test(o.feedPass.trim()))
    return { reason: `APRSIS_PASSCODE is not set: set the passcode of ${baseOf(o.serviceCall)}` };
  return { call: o.serviceCall.toUpperCase(), pass: o.feedPass.trim() };
}

/**
 * APRS-IS uplink. Logs in ONCE under the uplink callsign (`APRSIS_SERVICE_CALL`, with the passcode of its
 * base call). An item from a call of that same base call — the gateway's service call answering a radio
 * command, acking it or delivering held mail — goes out as a plain packet, so IGates gate a message to the
 * addressee on RF. An item from anyone else (a player's announced find) is relayed as THIRD-PARTY traffic,
 * so the player's call stays the inner source:
 *   SERVICE>APZACG,TCPIP*:}USERCALL>APZACG,TCPIP*:>Found AC-1234 via aprscaching.net
 */
export class AprsUplink {
  private sock?: net.Socket;
  private ready = false;
  private gen = 0; // connection generation — a replaced socket can never reconnect
  private timer?: ReturnType<typeof setTimeout>;
  private backoff: Backoff;
  constructor(private o: { host: string; port: number; serviceCall: string; servicePass: string; retryMs?: number }) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
  }

  start() {
    this.connect();
  }

  /** One reconnect per failure: only `close` schedules (it always follows `error`), stale sockets
   *  and already-scheduled timers are ignored. Delay backs off with jitter. */
  private retry(gen: number) {
    if (gen !== this.gen || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.backoff.next());
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
      this.backoff.reset(); // reachable again → next reconnect starts from the base interval
      s.write(`user ${this.o.serviceCall} pass ${this.o.servicePass} vers aprscaching 0.0\r\n`);
      this.ready = true;
    });
    s.on("error", () => {
      this.ready = false; // a socket in error is NOT a place to ack an outbox write against
    });
    s.on("close", () => {
      this.ready = false;
      this.retry(gen);
    });
  }

  /**
   * Publish a queued outbox item via third-party format. kind 'status'|'message'|'wx' — the payload
   * is the full APRS info field (a status `>…`, a message `:…`, or a WX report `!…_…`), so a WX
   * beacon flows through unchanged. The user's callsign stays the inner source.
   */
  publish(item: { src_call: string; tocall: string; payload: string }): boolean {
    const s = this.sock;
    // Only report success when the socket is verifiably alive. `ready` alone stays true until
    // error/close fires, so a write onto a half-dead socket would be acked (and the outbox item
    // deleted) without ever reaching APRS-IS. Gate on writable/!destroyed and catch a throw so the
    // caller keeps the item queued for the next tick.
    if (!this.ready || !s || !s.writable || s.destroyed) return false;
    const inner = `${item.src_call}>${item.tocall},TCPIP*:${item.payload}`;
    const frame =
      baseOf(item.src_call) === baseOf(this.o.serviceCall)
        ? `${inner}\r\n`
        : `${this.o.serviceCall}>${item.tocall},TCPIP*:}${inner}\r\n`;
    try {
      s.write(frame);
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }
}
