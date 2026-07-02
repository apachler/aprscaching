// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * simPeer.ts — a hardware-free loopback transport for the packet terminal (design harness only).
 *
 * The real terminal drives a `SerialKissTransport` over a physical KISS TNC. This drop-in implements
 * the same `TermTransport` surface but wires the far end to an in-process **BBS peer** built from the
 * real `@aprsweb/ax25` `ConnectedLink` — so the AX.25 SABM/UA handshake and I-frame exchange are
 * genuine, and the terminal renders a fully-populated connected session (banner, LIST/READ, monitor
 * traffic) with no radio. It never ships in the production Web Serial path; the harness injects it via
 * `PacketTerminal`'s `makeTransport` seam.
 *
 * The far-end BBS logic is the REAL `@aprsweb/packet` `BbsSession` interpreter driven over a canned
 * in-memory store — not a reimplemented L/R/S/B grammar. So the harness exercises the same FBB command
 * parser the ingest runs, and the Stage-3 Cogmind terminal shell drives one command model.
 */
import { ConnectedLink, encodeFrame, decodeFrame, parseAddr, PID_NO_L3, type Ax25Frame } from "@aprsweb/ax25";
import { BbsSession, type MessageStore, type BbsMsgMeta, type BbsMsgFull } from "@aprsweb/packet";
import type { MakeTransport, TermTransport } from "../packet/PacketTerminal.js";

const BBS = "OE8XBM-7"; // the emulated FBB BBS the terminal connects to

/** A tiny in-memory MessageStore seeding the demo session — the interpreter does all the grammar. */
function cannedStore(operator: string): MessageStore {
  const op = operator.toUpperCase();
  let seq = 2815;
  // newest first, so LL/LA read like a real BBS
  const msgs: BbsMsgFull[] = [
    { id: 2814, type: "P", from: "OE3ABC", to: op, subject: "Re: JN77 activation Sat", postedAt: 0, readAt: null,
      body: "Great, I'll bring the 2m beam and the DigiRig. Meet at the\nSchoeckl car park 0900z? 73 Martin OE3ABC." },
    { id: 2813, type: "P", from: "DL2XYZ", to: op, subject: "QSL via bureau OK", postedAt: 0, readAt: null,
      body: "Tnx for the JN77 QSO. QSL via the bureau is fine — card on its way.\n73 de DL2XYZ." },
    { id: 2790, type: "B", from: "OE8XBM", to: "ALL", subject: "Net Tue 19:00 on 144.800", postedAt: 0, readAt: null,
      body: "Weekly Graz packet net — Tuesdays 19:00 local on 144.800 MHz.\nConnect OE8XBM-7 for the BBS. All welcome, 73." },
  ];
  const meta = (m: BbsMsgFull): BbsMsgMeta => ({ id: m.id, type: m.type, from: m.from, to: m.to, subject: m.subject, postedAt: m.postedAt });
  return {
    listNew: (call) => msgs.filter((m) => m.type === "B" || (m.type === "P" && m.to === call.toUpperCase() && !m.readAt)).map(meta),
    listAll: () => msgs.map(meta),
    listBulletins: () => msgs.filter((m) => m.type === "B").map(meta),
    listMine: (call) => msgs.filter((m) => m.from === call.toUpperCase() || m.to === call.toUpperCase()).map(meta),
    read: (id) => { const m = msgs.find((x) => x.id === id); if (m && m.type === "P") m.readAt = 1; return m ?? null; },
    post: (m) => { const id = seq++; msgs.unshift({ ...m, id, postedAt: 0, replyTo: m.replyTo ?? null, readAt: null }); return id; },
    kill: (id, call) => {
      const i = msgs.findIndex((x) => x.id === id);
      if (i < 0) return false;
      const m = msgs[i]!;
      if (m.from !== call.toUpperCase() && m.to !== call.toUpperCase()) return false;
      msgs.splice(i, 1); return true;
    },
  };
}

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
  private session: BbsSession;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bi = 0;
  private closed = false;

  constructor(myCall: string, private onFrame: (f: Ax25Frame) => void, _onClose: (e?: Error) => void) {
    // The real FBB command interpreter, over a canned store — the harness runs the same grammar as the ingest.
    this.session = new BbsSession(myCall, cannedStore(myCall), BBS);
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
  private greet() { for (const l of this.session.greeting()) this.say(l); }
  /** Terminal → BBS: one input line through the real interpreter; emit its reply and honour disconnect. */
  private onLine(cmd: string) {
    const { lines, disconnect } = this.session.handle(cmd);
    for (const l of lines) this.say(l);
    if (disconnect) this.bbs.disconnect();
  }
}

/** Build the `makeTransport` factory the harness injects into `PacketTerminal`. */
export const makeSimTransport = (myCall: string): MakeTransport =>
  (onFrame, onClose) => new SimTransport(myCall, onFrame, onClose);
