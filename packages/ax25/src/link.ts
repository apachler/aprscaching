/**
 * link.ts — the AX.25 v2.2 connected-mode data-link state machine (LAPB-derived), modulo-8 (docs/25
 * P0). Event-driven and PURE: feed it received frames and a clock, and it emits frames to transmit,
 * delivers received info to layer 3, and announces state changes — no I/O, no real timers, so it is
 * exhaustively unit-testable by scripted exchange. The host owns the byte transport (KISS / Web
 * Serial / audio) and a periodic clock that calls poll().
 *
 * Implements: SABM/UA connect (+ incoming accept), DISC/UA release, I-frame transfer with windowing
 * and V(S)/V(R)/V(A), RR/RNR/REJ, T1 retransmission with N2 retries, T3 idle keepalive, and the
 * timer-recovery (poll/final) cycle. Modulo-128 (SABME) and SREJ are documented follow-ons.
 */
import { type Ax25Address, type Ax25Frame, type FrameType, sameAddr, PID_NO_L3 } from "./frame.js";

export type LinkState = "disconnected" | "connecting" | "connected" | "recovering" | "disconnecting";

export interface LinkConfig { t1: number; t3: number; n2: number; window: number; pid: number }
export const DEFAULT_CONFIG: LinkConfig = { t1: 3000, t3: 30000, n2: 10, window: 4, pid: PID_NO_L3 };

export interface LinkEvents {
  send(frame: Ax25Frame): void;       // transmit a frame
  deliver(info: Uint8Array): void;    // hand received I-frame data up to layer 3
  state(s: LinkState, prev: LinkState): void;
  error?(msg: string): void;          // link failure (N2 exceeded, FRMR, …)
}

const MOD = 8;
const outstanding = (va: number, vs: number): number => (vs - va + MOD) % MOD;
const inWindow = (lo: number, x: number, hi: number): boolean => ((x - lo + MOD) % MOD) <= ((hi - lo + MOD) % MOD);

interface SentIFrame { ns: number; info: Uint8Array }

export class ConnectedLink {
  state: LinkState = "disconnected";
  private cfg: LinkConfig;
  private vs = 0; private vr = 0; private va = 0;          // send / receive / ack state vars
  private pending: Uint8Array[] = [];                      // layer-3 data not yet sent as I-frames
  private sent: SentIFrame[] = [];                         // I-frames sent, awaiting ack (contiguous from V(A))
  private rc = 0;                                          // retry counter
  private peerBusy = false;                                // peer sent RNR
  private rejSent = false;                                 // we sent a REJ (reject exception)
  private t1: number | null = null;                       // absolute deadlines (ms); null = stopped
  private t3: number | null = null;

  constructor(
    public local: Ax25Address, public remote: Ax25Address, private ev: LinkEvents,
    cfg: Partial<LinkConfig> = {}, private clock: () => number = () => Date.now(),
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  // ----------------------------------------------------------------- user requests
  connect(): void {
    if (this.state !== "disconnected") return;
    this.reset();
    this.tx("SABM", true, true); this.rc = 0; this.startT1();
    this.to("connecting");
  }
  disconnect(): void {
    if (this.state === "disconnected") return;
    if (this.state === "connecting") { this.stopAll(); this.to("disconnected"); return; }
    this.pending = []; this.sent = [];
    this.tx("DISC", true, true); this.rc = 0; this.startT1(); this.stopT3();
    this.to("disconnecting");
  }
  /** Queue layer-3 data to send as I-frame(s). */
  send(info: Uint8Array): void {
    this.pending.push(info);
    if (this.state === "connected") this.sendPending();
  }

  // ----------------------------------------------------------------- inbound frames
  onReceive(f: Ax25Frame): void {
    if (!sameAddr(f.src, this.remote) || !sameAddr(f.dst, this.local)) return; // not our link
    switch (f.type) {
      case "SABM": return this.onSabm(f);
      case "DISC": return this.onDisc(f);
      case "UA": return this.onUa();
      case "DM": return this.onDm();
      case "I": return this.onI(f);
      case "RR": case "RNR": case "REJ": return this.onS(f);
      case "FRMR": this.ev.error?.("FRMR from peer — resetting"); return this.reestablish();
      default: return; // UI/XID/TEST/SREJ/SABME — not handled at this layer in P0
    }
  }

  /** Advance timers; the host calls this periodically (it reads the injected clock). */
  poll(): void {
    const now = this.clock();
    if (this.t1 !== null && now >= this.t1) this.onT1();
    if (this.t3 !== null && now >= this.t3) this.onT3();
  }

  // ----------------------------------------------------------------- U-frame handlers
  private onSabm(f: Ax25Frame): void {           // incoming connect, or peer re-establishing
    this.reset();
    this.tx("UA", false, f.pf);
    this.startT3();
    this.to("connected");
  }
  private onDisc(f: Ax25Frame): void {
    this.tx("UA", false, f.pf); this.stopAll(); this.to("disconnected");
  }
  private onUa(): void {
    if (this.state === "connecting") { this.reset(); this.stopT1(); this.startT3(); this.to("connected"); this.sendPending(); }
    else if (this.state === "disconnecting") { this.stopAll(); this.to("disconnected"); }
  }
  private onDm(): void {
    if (this.state !== "disconnected") { this.stopAll(); this.to("disconnected"); }
  }

  // ----------------------------------------------------------------- I / S handlers
  private onI(f: Ax25Frame): void {
    if (this.state !== "connected" && this.state !== "recovering") return;
    this.ackOwn(f.nr!);                                   // its N(R) acks our outstanding I-frames
    if (f.ns === this.vr) {                               // in-sequence
      this.vr = (this.vr + 1) % MOD;
      this.rejSent = false;
      if (f.info) this.ev.deliver(f.info);
      if (f.pf) this.tx("RR", false, true);               // owed an immediate (final) ack
      else if (!this.sendPending()) this.tx("RR", false, false);
    } else if (!this.rejSent) {                            // out of sequence → one REJ
      this.tx("REJ", false, f.pf); this.rejSent = true;
    } else if (f.pf) {
      this.tx("RR", false, true);
    }
  }
  private onS(f: Ax25Frame): void {
    if (this.state !== "connected" && this.state !== "recovering") return;
    this.peerBusy = f.type === "RNR";
    this.ackOwn(f.nr!);
    if (f.type === "REJ") this.retransmitFrom(f.nr!);
    if (this.state === "recovering" && f.pf) { this.rc = 0; this.to("connected"); this.retransmitFrom(this.va); }
    if (f.pf && f.command) this.tx("RR", false, true);    // answer a poll with a final
    if (this.state === "connected") this.sendPending();
  }

  // ----------------------------------------------------------------- timers
  private onT1(): void {
    if (this.state === "connecting") {
      if (this.rc++ < this.cfg.n2) { this.tx("SABM", true, true); this.startT1(); } else this.fail("no answer to SABM");
    } else if (this.state === "disconnecting") {
      if (this.rc++ < this.cfg.n2) { this.tx("DISC", true, true); this.startT1(); } else { this.stopAll(); this.to("disconnected"); }
    } else if (this.state === "connected" || this.state === "recovering") {
      if (this.rc++ < this.cfg.n2) { this.to("recovering"); this.tx("RR", true, true); this.startT1(); } else this.fail("N2 retries exceeded");
    }
  }
  private onT3(): void {
    if (this.state === "connected") { this.rc = 0; this.to("recovering"); this.tx("RR", true, true); this.startT1(); }
  }

  // ----------------------------------------------------------------- helpers
  /** Send as many queued I-frames as the window allows. Returns whether anything was sent. */
  private sendPending(): boolean {
    let any = false;
    while (this.pending.length && !this.peerBusy && outstanding(this.va, this.vs) < this.cfg.window) {
      const info = this.pending.shift()!;
      this.ev.send({ dst: this.remote, src: this.local, command: true, type: "I", pf: false, nr: this.vr, ns: this.vs, pid: this.cfg.pid, info });
      this.sent.push({ ns: this.vs, info });
      this.vs = (this.vs + 1) % MOD;
      this.stopT3(); this.startT1();
      any = true;
    }
    return any;
  }
  /** Remove acked I-frames — N(R) acknowledges everything before it. */
  private ackOwn(nr: number): void {
    if (!inWindow(this.va, nr, this.vs)) return;          // invalid N(R) — ignore
    while (this.va !== nr && this.sent.length) { this.sent.shift(); this.va = (this.va + 1) % MOD; }
    this.va = nr; this.rc = 0;
    if (this.va === this.vs) { this.stopT1(); this.startT3(); } else this.startT1();
  }
  /** Retransmit the unacked I-frames from N(R) onward (REJ recovery / poll-final resync). */
  private retransmitFrom(nr: number): void {
    const last = (this.vs - 1 + MOD) % MOD;
    let sentAny = false;
    for (const s of this.sent) if (inWindow(nr, s.ns, last)) {
      this.ev.send({ dst: this.remote, src: this.local, command: true, type: "I", pf: false, nr: this.vr, ns: s.ns, pid: this.cfg.pid, info: s.info });
      sentAny = true;
    }
    if (sentAny) this.startT1();
  }

  private tx(type: FrameType, command: boolean, pf: boolean): void {
    this.ev.send({ dst: this.remote, src: this.local, command, type, pf, nr: this.vr });
  }
  private reset(): void { this.vs = this.vr = this.va = this.rc = 0; this.pending = []; this.sent = []; this.peerBusy = false; this.rejSent = false; }
  private reestablish(): void { this.reset(); this.tx("SABM", true, true); this.rc = 0; this.startT1(); this.to("connecting"); }
  private fail(msg: string): void { this.ev.error?.(msg); this.tx("DM", false, true); this.stopAll(); this.to("disconnected"); }

  private startT1(): void { this.t1 = this.clock() + this.cfg.t1; }
  private stopT1(): void { this.t1 = null; }
  private startT3(): void { this.t3 = this.clock() + this.cfg.t3; }
  private stopT3(): void { this.t3 = null; }
  private stopAll(): void { this.stopT1(); this.stopT3(); }
  private to(s: LinkState): void { if (s !== this.state) { const prev = this.state; this.state = s; this.ev.state(s, prev); } }
}
