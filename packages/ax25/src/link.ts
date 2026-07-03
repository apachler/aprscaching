// SPDX-License-Identifier: MIT
/**
 * link.ts — the AX.25 v2.2 connected-mode data-link state machine (LAPB-derived), modulo-8 AND
 * modulo-128. Event-driven and PURE: feed it received frames and a clock, and it
 * emits frames to transmit, delivers received info to layer 3, and announces state changes — no I/O,
 * no real timers, so it is exhaustively unit-testable by scripted exchange. The host owns the byte
 * transport (KISS / Web Serial / audio) and a periodic clock that calls poll().
 *
 * Implements: SABM/UA connect (+ incoming accept), the modulo-128 **SABME** extended-window connect,
 * DISC/UA release, I-frame transfer with windowing and V(S)/V(R)/V(A), RR/RNR/REJ, the **SREJ**
 * (selective reject) recovery path with a receive buffer, T1 retransmission with N2 retries, T3 idle
 * keepalive, and the timer-recovery (poll/final) cycle. The modulo is chosen by `cfg.modulo` for an
 * outgoing connect and adopted from the peer's SABM/SABME on an incoming one; SREJ is gated by `cfg.srej`.
 */
import { type Ax25Address, type Ax25Frame, type FrameType, sameAddr, PID_NO_L3 } from "./frame.js";

export type LinkState = "disconnected" | "connecting" | "connected" | "recovering" | "disconnecting";

export interface LinkConfig {
  t1: number;
  t3: number;
  n2: number;
  window: number;
  pid: number;
  modulo?: 8 | 128; // sequence-number modulus; 128 connects with SABME (extended window). Default 8.
  srej?: boolean; // use SREJ (selective reject) on a receive gap instead of REJ (go-back-N). Default off.
}
export const DEFAULT_CONFIG: LinkConfig = {
  t1: 3000,
  t3: 30000,
  n2: 10,
  window: 4,
  pid: PID_NO_L3,
  modulo: 8,
  srej: false,
};

export interface LinkEvents {
  send(frame: Ax25Frame): void; // transmit a frame
  deliver(info: Uint8Array): void; // hand received I-frame data up to layer 3
  state(s: LinkState, prev: LinkState): void;
  error?(msg: string): void; // link failure (N2 exceeded, FRMR, …)
}

interface SentIFrame {
  ns: number;
  info: Uint8Array;
}

export class ConnectedLink {
  state: LinkState = "disconnected";
  private cfg: LinkConfig;
  private vs = 0;
  private vr = 0;
  private va = 0; // send / receive / ack state vars
  private pending: Uint8Array[] = []; // layer-3 data not yet sent as I-frames
  private sent: SentIFrame[] = []; // I-frames sent, awaiting ack (contiguous from V(A))
  private rc = 0; // retry counter
  private peerBusy = false; // peer sent RNR
  private rejSent = false; // we sent a REJ (reject exception)
  private rxbuf = new Map<number, Uint8Array>(); // SREJ: out-of-sequence I-frames held for reassembly
  private srejSent = new Set<number>(); // SREJ: sequence numbers we've selectively rejected
  private t1: number | null = null; // absolute deadlines (ms); null = stopped
  private t3: number | null = null;
  private mod = 8; // active sequence modulus (8 or 128)

  constructor(
    public local: Ax25Address,
    public remote: Ax25Address,
    private ev: LinkEvents,
    cfg: Partial<LinkConfig> = {},
    private clock: () => number = () => Date.now(),
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.mod = this.cfg.modulo === 128 ? 128 : 8;
  }

  /** True when the link is running modulo-128 (extended window) — the host uses this to encode/decode I/S. */
  get extended(): boolean {
    return this.mod === 128;
  }
  get modulo(): number {
    return this.mod;
  }

  // modulo-aware sequence arithmetic (works for both 8 and 128)
  private outstanding(va: number, vs: number): number {
    return (vs - va + this.mod) % this.mod;
  }
  private inWindow(lo: number, x: number, hi: number): boolean {
    return (x - lo + this.mod) % this.mod <= (hi - lo + this.mod) % this.mod;
  }

  // ----------------------------------------------------------------- user requests
  connect(): void {
    if (this.state !== "disconnected") return;
    this.mod = this.cfg.modulo === 128 ? 128 : 8;
    this.reset();
    this.tx(this.mod === 128 ? "SABME" : "SABM", true, true);
    this.rc = 0;
    this.startT1();
    this.to("connecting");
  }
  disconnect(): void {
    if (this.state === "disconnected") return;
    if (this.state === "connecting") {
      this.stopAll();
      this.to("disconnected");
      return;
    }
    this.pending = [];
    this.sent = [];
    this.tx("DISC", true, true);
    this.rc = 0;
    this.startT1();
    this.stopT3();
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
      case "SABM":
        return this.onSabm(f, 8);
      case "SABME":
        return this.onSabm(f, 128);
      case "DISC":
        return this.onDisc(f);
      case "UA":
        return this.onUa();
      case "DM":
        return this.onDm();
      case "I":
        return this.onI(f);
      case "RR":
      case "RNR":
      case "REJ":
      case "SREJ":
        return this.onS(f);
      case "FRMR":
        this.ev.error?.("FRMR from peer — resetting");
        return this.reestablish();
      default:
        return; // UI/XID/TEST — not handled at this layer in P0
    }
  }

  /** Advance timers; the host calls this periodically (it reads the injected clock). */
  poll(): void {
    const now = this.clock();
    if (this.t1 !== null && now >= this.t1) this.onT1();
    if (this.t3 !== null && now >= this.t3) this.onT3();
  }

  // ----------------------------------------------------------------- U-frame handlers
  private onSabm(f: Ax25Frame, mod: 8 | 128): void {
    // incoming connect, or peer re-establishing
    this.mod = mod; // adopt the modulus the peer asked for (SABM/SABME)
    this.reset();
    this.tx("UA", false, f.pf);
    this.startT3();
    this.to("connected");
  }
  private onDisc(f: Ax25Frame): void {
    this.tx("UA", false, f.pf);
    this.stopAll();
    this.to("disconnected");
  }
  private onUa(): void {
    if (this.state === "connecting") {
      this.reset();
      this.stopT1();
      this.startT3();
      this.to("connected");
      this.sendPending();
    } else if (this.state === "disconnecting") {
      this.stopAll();
      this.to("disconnected");
    }
  }
  private onDm(): void {
    if (this.state !== "disconnected") {
      this.stopAll();
      this.to("disconnected");
    }
  }

  // ----------------------------------------------------------------- I / S handlers
  private onI(f: Ax25Frame): void {
    if (this.state !== "connected" && this.state !== "recovering") return;
    this.ackOwn(f.nr!); // its N(R) acks our outstanding I-frames
    if (f.ns === this.vr) {
      // in-sequence
      this.vr = (this.vr + 1) % this.mod;
      this.rejSent = false;
      if (f.info) this.ev.deliver(f.info);
      this.drainRxBuf(); // SREJ: deliver any buffered frames now contiguous
      if (f.pf)
        this.tx("RR", false, true); // owed an immediate (final) ack
      else if (!this.sendPending()) this.tx("RR", false, false);
    } else if (this.cfg.srej && this.inWindow(this.vr, f.ns!, (this.vr + this.mod - 2) % this.mod)) {
      // SREJ: buffer the out-of-sequence frame and selectively reject only the specific missing sequence(s).
      if (f.info && !this.rxbuf.has(f.ns!)) this.rxbuf.set(f.ns!, f.info);
      for (let s = this.vr; s !== f.ns; s = (s + 1) % this.mod) {
        if (!this.srejSent.has(s)) {
          this.txS("SREJ", s, false);
          this.srejSent.add(s);
        }
      }
      if (f.pf) this.tx("RR", false, true);
    } else if (!this.rejSent) {
      // out of sequence → one REJ (go-back-N)
      this.tx("REJ", false, f.pf);
      this.rejSent = true;
    } else if (f.pf) {
      this.tx("RR", false, true);
    }
  }
  /** SREJ: after an in-sequence delivery, release any buffered frames that are now contiguous from V(R). */
  private drainRxBuf(): void {
    while (this.rxbuf.has(this.vr)) {
      const info = this.rxbuf.get(this.vr)!;
      this.rxbuf.delete(this.vr);
      this.srejSent.delete(this.vr);
      if (info.length) this.ev.deliver(info);
      this.vr = (this.vr + 1) % this.mod;
    }
  }
  private onS(f: Ax25Frame): void {
    if (this.state !== "connected" && this.state !== "recovering") return;
    this.peerBusy = f.type === "RNR";
    this.ackOwn(f.nr!);
    if (f.type === "REJ") this.retransmitFrom(f.nr!);
    else if (f.type === "SREJ") this.retransmitOne(f.nr!); // resend only the selectively-rejected frame
    if (this.state === "recovering" && f.pf) {
      this.rc = 0;
      this.to("connected");
      this.retransmitFrom(this.va);
    }
    if (f.pf && f.command) this.tx("RR", false, true); // answer a poll with a final
    if (this.state === "connected") this.sendPending();
  }

  // ----------------------------------------------------------------- timers
  private onT1(): void {
    if (this.state === "connecting") {
      // SR-PKT-04: retry with the SAME frame we connected with — a mod-128 link must resend SABME,
      // not plain SABM (which would flip the peer to mod-8 and garble the control fields).
      if (this.rc++ < this.cfg.n2) {
        this.tx(this.mod === 128 ? "SABME" : "SABM", true, true);
        this.startT1();
      } else this.fail(`no answer to ${this.mod === 128 ? "SABME" : "SABM"}`);
    } else if (this.state === "disconnecting") {
      if (this.rc++ < this.cfg.n2) {
        this.tx("DISC", true, true);
        this.startT1();
      } else {
        this.stopAll();
        this.to("disconnected");
      }
    } else if (this.state === "connected" || this.state === "recovering") {
      if (this.rc++ < this.cfg.n2) {
        this.to("recovering");
        this.tx("RR", true, true);
        this.startT1();
      } else this.fail("N2 retries exceeded");
    }
  }
  private onT3(): void {
    if (this.state === "connected") {
      this.rc = 0;
      this.to("recovering");
      this.tx("RR", true, true);
      this.startT1();
    }
  }

  // ----------------------------------------------------------------- helpers
  /** Send as many queued I-frames as the window allows. Returns whether anything was sent. */
  private sendPending(): boolean {
    let any = false;
    while (this.pending.length && !this.peerBusy && this.outstanding(this.va, this.vs) < this.cfg.window) {
      const info = this.pending.shift()!;
      this.txI(this.vs, info);
      this.sent.push({ ns: this.vs, info });
      this.vs = (this.vs + 1) % this.mod;
      this.stopT3();
      this.startT1();
      any = true;
    }
    return any;
  }
  /** Remove acked I-frames — N(R) acknowledges everything before it. */
  private ackOwn(nr: number): void {
    if (!this.inWindow(this.va, nr, this.vs)) return; // invalid N(R) — ignore
    while (this.va !== nr && this.sent.length) {
      this.sent.shift();
      this.va = (this.va + 1) % this.mod;
    }
    this.va = nr;
    this.rc = 0;
    if (this.va === this.vs) {
      this.stopT1();
      this.startT3();
    } else this.startT1();
  }
  /** Retransmit the unacked I-frames from N(R) onward (REJ recovery / poll-final resync). */
  private retransmitFrom(nr: number): void {
    const last = (this.vs - 1 + this.mod) % this.mod;
    let sentAny = false;
    for (const s of this.sent)
      if (this.inWindow(nr, s.ns, last)) {
        this.txI(s.ns, s.info);
        sentAny = true;
      }
    if (sentAny) this.startT1();
  }
  /** SREJ recovery: retransmit ONLY the one selectively-rejected I-frame. */
  private retransmitOne(nr: number): void {
    const s = this.sent.find((x) => x.ns === nr);
    if (s) {
      this.txI(s.ns, s.info);
      this.startT1();
    }
  }

  private tx(type: FrameType, command: boolean, pf: boolean): void {
    this.ev.send({ dst: this.remote, src: this.local, command, type, pf, nr: this.vr, extended: this.mod === 128 });
  }
  /** Emit a supervisory frame with an explicit N(R) (used by SREJ, which rejects a specific sequence). */
  private txS(type: FrameType, nr: number, pf: boolean): void {
    this.ev.send({ dst: this.remote, src: this.local, command: false, type, pf, nr, extended: this.mod === 128 });
  }
  /** Emit an I-frame carrying `info` at sequence `ns` (piggybacking the current V(R)). */
  private txI(ns: number, info: Uint8Array): void {
    this.ev.send({
      dst: this.remote,
      src: this.local,
      command: true,
      type: "I",
      pf: false,
      nr: this.vr,
      ns,
      pid: this.cfg.pid,
      info,
      extended: this.mod === 128,
    });
  }
  private reset(): void {
    this.vs = this.vr = this.va = this.rc = 0;
    this.pending = [];
    this.sent = [];
    this.peerBusy = false;
    this.rejSent = false;
    this.rxbuf.clear();
    this.srejSent.clear();
  }
  private reestablish(): void {
    this.reset();
    this.tx(this.mod === 128 ? "SABME" : "SABM", true, true);
    this.rc = 0;
    this.startT1();
    this.to("connecting");
  }
  private fail(msg: string): void {
    this.ev.error?.(msg);
    this.tx("DM", false, true);
    this.stopAll();
    this.to("disconnected");
  }

  private startT1(): void {
    this.t1 = this.clock() + this.cfg.t1;
  }
  private stopT1(): void {
    this.t1 = null;
  }
  private startT3(): void {
    this.t3 = this.clock() + this.cfg.t3;
  }
  private stopT3(): void {
    this.t3 = null;
  }
  private stopAll(): void {
    this.stopT1();
    this.stopT3();
  }
  private to(s: LinkState): void {
    if (s !== this.state) {
      const prev = this.state;
      this.state = s;
      this.ev.state(s, prev);
    }
  }
}
