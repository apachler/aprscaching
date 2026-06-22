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
  constructor(private o: { host: string; port: number; serviceCall: string; servicePass: string }) {}

  start() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      s.write(`user ${this.o.serviceCall} pass ${this.o.servicePass} vers aprscaching 0.0\r\n`);
      this.ready = true;
    });
    const retry = () => { this.ready = false; setTimeout(() => this.start(), 3000); };
    s.on("error", retry); s.on("close", retry);
  }

  /** publish a queued outbox item. kind 'status'|'message'; payload is the info field. */
  publish(item: { src_call: string; tocall: string; payload: string }): boolean {
    if (!this.ready || !this.sock) return false;
    const inner = `${item.src_call}>${item.tocall},TCPIP*:${item.payload}`;
    const frame = `${this.o.serviceCall}>${item.tocall},TCPIP*:}${inner}\r\n`;
    this.sock.write(frame);
    return true;
  }
}
