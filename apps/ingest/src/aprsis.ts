import net from "node:net";
import { EventEmitter } from "node:events";

export interface AprsIsOpts {
  host: string; port: number; callsign: string; passcode: string; filter: string;
}

/** Persistent APRS-IS client: connects, logs in with a filter, auto-reconnects, emits lines. */
export class AprsIs extends EventEmitter {
  private sock?: net.Socket;
  private buf = "";
  constructor(private o: AprsIsOpts) { super(); }

  start() { this.connect(); }

  private connect() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
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
    const retry = () => { this.emit("down"); setTimeout(() => this.connect(), 3000); };
    s.on("error", retry);
    s.on("close", retry);
  }
}
