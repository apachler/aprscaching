/**
 * simPeer.ts — a hardware-free loopback transport for the packet terminal (design harness only).
 *
 * The real terminal drives a `SerialKissTransport` over a physical KISS TNC. This drop-in implements
 * the same `TermTransport` surface but wires the far end to an in-process **BBS peer** built from the
 * real `@aprsweb/ax25` `ConnectedLink` — so the AX.25 SABM/UA handshake and I-frame exchange are
 * genuine, and the terminal renders a fully-populated connected session (banner, LIST/READ, monitor
 * traffic) with no radio. It never ships in the production Web Serial path; the harness injects it via
 * `PacketTerminal`'s `makeTransport` seam.
 */
import { ConnectedLink, encodeFrame, decodeFrame, parseAddr, PID_NO_L3, type Ax25Frame } from "@aprsweb/ax25";
import type { MakeTransport, TermTransport } from "../packet/PacketTerminal.js";

const BBS = "OE8XBM-7"; // the emulated FBB BBS the terminal connects to

const enc = (s: string): Uint8Array => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };
const uiFrame = (src: string, dst: string, info: string): Ax25Frame =>
  ({ dst: parseAddr(dst), src: parseAddr(src), command: true, type: "UI", pf: false, pid: PID_NO_L3, info: enc(info) });

const BEACONS: [string, string, string][] = [
  ["OE1XDS-1", "APRS", "!4712.34N/01621.55E# Wien iGate +14C"],
  ["OE8XBM-7", "BEACON", "FBB BBS Graz - packet welcome"],
  ["OE6XRR-3", "APN391", "Schoeckl digipeater WIDE2-2"],
  ["OE8APR-9", "APRS", "/venue mobile 88 km/h enroute JN77"],
  ["DB0FGB", "APWW11", "_ wx 12.4C 1013hPa hum 71%"],
];

class SimTransport implements TermTransport {
  private bbs: ConnectedLink;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bi = 0;
  private closed = false;

  constructor(myCall: string, private onFrame: (f: Ax25Frame) => void, _onClose: (e?: Error) => void) {
    // The far-end BBS link: local = BBS, remote = the operator. Encode→decode each frame so the loopback
    // exercises the real wire codec (catches framing bugs), then hand it straight back to the terminal.
    this.bbs = new ConnectedLink(parseAddr(BBS), parseAddr(myCall), {
      // Deliver back to the terminal on a microtask — a real serial link is asynchronous; delivering
      // synchronously would re-enter the terminal link's state machine mid-connect and drop the UA.
      send: (f) => { if (!this.closed) queueMicrotask(() => { if (!this.closed) this.onFrame(decodeFrame(encodeFrame(f)) ?? f); }); },
      deliver: (info) => this.onLine(String.fromCharCode(...info).trim()),
      state: (s) => { if (s === "connected") this.greet(); },
    }, { pid: PID_NO_L3 });
  }

  connect(): Promise<void> {
    this.timer = setInterval(() => {
      if (this.closed) return;
      this.bbs.poll();
      const b = BEACONS[this.bi++ % BEACONS.length]!;
      this.onFrame(uiFrame(b[0], b[1], b[2]));
    }, 900);
    return Promise.resolve();
  }
  disconnect(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; return Promise.resolve(); }
  /** Terminal → BBS: connected-mode frames go to the peer link (async, like a real link); UI ignored. */
  send(f: Ax25Frame): void {
    if (f.type === "UI") return;
    queueMicrotask(() => { if (!this.closed) this.bbs.onReceive(decodeFrame(encodeFrame(f)) ?? f); });
  }

  private say(line: string) { this.bbs.send(enc(line + "\r")); }
  private greet() {
    this.say("[OE8XBM-7 FBB BBS v7.11] JN77rb  Graz, Austria");
    this.say("Hello - welcome back. You have 2 unread messages.");
    this.say("Commands:  (L)ist  (R)ead n  (S)end  (B)ye");
    this.say(">");
  }
  private onLine(cmd: string) {
    const c = cmd.toUpperCase();
    if (c === "L" || c.startsWith("LIST")) {
      this.say("Msg#  TO       FROM     DATE   SIZE  SUBJECT");
      this.say("2814  OE8APR   OE3ABC   07-01   412  Re: JN77 activation Sat");
      this.say("2813  OE8APR   DL2XYZ   06-30   128  QSL via bureau OK");
      this.say("2790  ALL      OE8XBM   06-28   256  B: Net Tue 19:00 on 144.800");
      this.say(">");
    } else if (c === "B" || c.startsWith("BYE")) {
      this.say("73 de OE8XBM-7 - packet is not dead.");
      this.bbs.disconnect();
    } else if (c.startsWith("R")) {
      this.say("Msg #2814 from OE3ABC - Re: JN77 activation Sat");
      this.say("Great, I'll bring the 2m beam and the DigiRig. Meet at the");
      this.say("Schoeckl car park 0900z? 73 Martin OE3ABC");
      this.say(">");
    } else {
      this.say("? try L, R n, S or B");
      this.say(">");
    }
  }
}

/** Build the `makeTransport` factory the harness injects into `PacketTerminal`. */
export const makeSimTransport = (myCall: string): MakeTransport =>
  (onFrame, onClose) => new SimTransport(myCall, onFrame, onClose);
