// SPDX-License-Identifier: MIT
/**
 * netrom-circuit.ts — the NET/ROM L4 transport circuit state machine, from the open
 * NET/ROM protocol spec. A "conventional sliding-window protocol" for end-to-end flow/error control
 * between two nodes, riding the transport header (netrom-wire.ts). Pure + line-free; the host routes the
 * emitted packets (wrapping them with a network header) and feeds inbound transport packets in.
 *
 * Implemented: connect (ConnReq/ConnAck + window negotiation), disconnect (DiscReq/DiscAck), in-order
 * Information transfer with cumulative InfoAck, automatic fragmentation/reassembly at the 236-byte limit
 * (more-follows flag), and choke (pause on peer congestion). Selective NAK + timer-driven retransmit are
 * documented follow-ons (like SREJ / modulo-128 at L2) — not needed for the loss-free happy path.
 */
import { NrOp, NR_MORE, NR_CHOKE, type NrTransport } from "./netrom-wire.js";
import { encodeAddress, decodeAddress, type Ax25Address } from "@aprscaching/ax25";

export const NR_MAX_INFO = 236; // 256-byte AX.25 frame − 20-byte net+transport header
const MOD = 256; // 8-bit transport sequence numbers → windows up to 127
const MAX_TXQ = 2048; // bound the outbound fragment queue (backpressure, no OOM)

export type CircuitState = "disconnected" | "connecting" | "connected" | "disconnecting";
export interface NrTpPacket {
  tp: NrTransport;
  info: Uint8Array;
}
export interface CircuitEvents {
  send(p: NrTpPacket): void; // emit a transport packet (host adds the network header + routes it)
  deliver(info: Uint8Array): void; // hand a reassembled L4 message up
  state(s: CircuitState, prev: CircuitState): void;
}

/** One end of a NET/ROM transport circuit. `id` is this end's local circuit {index, id}. */
export class NetromCircuit {
  state: CircuitState = "disconnected";
  private myIndex: number;
  private myId: number;
  private yourIndex = 0;
  private yourId = 0;
  private vs = 0;
  private va = 0;
  private vr = 0; // send / ack / receive sequence vars (mod 256)
  private window = 4;
  private choked = false; // peer sent choke → stop sending
  private txq: Array<{ info: Uint8Array; more: boolean }> = []; // queued fragments + their more-follows flag
  private sent: Array<{ seq: number; info: Uint8Array; more: boolean }> = []; // unacked window (for retransmit)
  private rxFrag: Uint8Array[] = []; // reassembly buffer for more-follows fragments

  // Clock-injected T1 so a lost ConnReq/Info/DiscReq is retransmitted and the circuit is
  // eventually torn down instead of wedging forever. The host drives `poll()` on an interval.
  private clock: () => number;
  private t1Ms: number;
  private n2: number;
  private t1 = 0; // retransmit deadline (0 = disarmed)
  private rc = 0; // retransmit count for the current outstanding item
  private connReqInfo: Uint8Array | null = null; // cached to retransmit the ConnReq

  constructor(
    private ev: CircuitEvents,
    id: { index: number; id: number },
    private origin?: { user: Ax25Address; node: Ax25Address },
    opts?: { clock?: () => number; t1Ms?: number; n2?: number },
  ) {
    this.myIndex = id.index;
    this.myId = id.id;
    this.clock = opts?.clock ?? (() => Date.now());
    this.t1Ms = opts?.t1Ms ?? 5000;
    this.n2 = opts?.n2 ?? 5;
  }

  private armFresh(): void {
    this.t1 = this.clock() + this.t1Ms;
    this.rc = 0;
  } // new activity: fresh deadline + retries
  private rearm(): void {
    this.t1 = this.clock() + this.t1Ms;
  } // after a retransmit (rc already bumped)
  private disarm(): void {
    this.t1 = 0;
    this.rc = 0;
  }

  /** Drive the retransmit timer — the host calls this on a ~1 s interval (like the AX.25 link). */
  poll(): void {
    if (!this.t1 || this.clock() < this.t1) return;
    if (this.rc >= this.n2) {
      this.disarm();
      this.to("disconnected");
      return;
    } // gave up → tear down + free the object
    this.rc++;
    if (this.state === "connecting" && this.connReqInfo) {
      this.tx(
        { circuitIndex: this.myIndex, circuitId: this.myId, txSeq: 0, rxSeq: 0, opcode: NrOp.ConnReq, flags: 0 },
        this.connReqInfo,
      );
    } else if (this.state === "disconnecting") {
      this.tx(
        { circuitIndex: this.yourIndex, circuitId: this.yourId, txSeq: 0, rxSeq: 0, opcode: NrOp.DiscReq, flags: 0 },
        new Uint8Array(),
      );
    } else if (this.state === "connected") {
      for (const s of this.sent)
        // resend the whole unacked window
        this.tx(
          {
            circuitIndex: this.yourIndex,
            circuitId: this.yourId,
            txSeq: s.seq,
            rxSeq: this.vr,
            opcode: NrOp.Info,
            flags: s.more ? NR_MORE : 0,
          },
          s.info,
        );
    }
    this.rearm();
  }

  /** This end's local circuit identity — a received transport packet carries these so a node can demux it. */
  get localIndex(): number {
    return this.myIndex;
  }
  get localId(): number {
    return this.myId;
  }
  /** The peer's circuit identity (from its ConnReq/ConnAck) — matches a RETRANSMITTED ConnReq to
   *  the circuit that already accepted it, so the retry re-acks instead of opening a duplicate. */
  get remoteIndex(): number {
    return this.yourIndex;
  }
  get remoteId(): number {
    return this.yourId;
  }

  /** Initiate the circuit: send a Connect Request proposing `window`. */
  connect(window = 4): void {
    if (this.state !== "disconnected" || !this.origin) return;
    this.window = window;
    const info = new Uint8Array([
      window,
      ...encodeAddress(this.origin.user, false, false),
      ...encodeAddress(this.origin.node, false, true),
    ]);
    this.connReqInfo = info;
    this.tx(
      { circuitIndex: this.myIndex, circuitId: this.myId, txSeq: 0, rxSeq: 0, opcode: NrOp.ConnReq, flags: 0 },
      info,
    );
    this.armFresh();
    this.to("connecting");
  }

  disconnect(): void {
    if (this.state === "disconnected" || this.state === "disconnecting") return;
    this.tx(
      { circuitIndex: this.yourIndex, circuitId: this.yourId, txSeq: 0, rxSeq: 0, opcode: NrOp.DiscReq, flags: 0 },
      new Uint8Array(),
    );
    this.armFresh();
    this.to("disconnecting");
  }

  /** Queue an L4 message to send; it's fragmented to ≤236 bytes and streamed as Information packets. */
  send(info: Uint8Array): void {
    const frags: Uint8Array[] = [];
    for (let off = 0; off < Math.max(info.length, 1); off += NR_MAX_INFO) {
      frags.push(info.slice(off, off + NR_MAX_INFO));
      if (info.length === 0) break;
    }
    if (this.txq.length + frags.length > MAX_TXQ) return; // backpressure — drop rather than grow without bound
    frags.forEach((f, i) => this.txq.push({ info: f, more: i < frags.length - 1 }));
    if (this.state === "connected") this.pump();
  }

  /** Handle an inbound transport packet (the host has stripped the network header). */
  onPacket(tp: NrTransport, info: Uint8Array): void {
    switch (tp.opcode) {
      case NrOp.ConnReq:
        return this.onConnReq(tp, info);
      case NrOp.ConnAck:
        return this.onConnAck(tp, info);
      case NrOp.DiscReq:
        return this.onDiscReq();
      case NrOp.DiscAck:
        return this.onDiscAck();
      case NrOp.Info:
        return this.onInfo(tp, info);
      case NrOp.InfoAck:
        return this.onInfoAck(tp);
      default:
        return;
    }
  }

  // ----------------------------------------------------------------- handlers
  private onConnReq(tp: NrTransport, info: Uint8Array): void {
    // accept: their circuit is (index,id); negotiate window = min(proposed, ours)
    this.yourIndex = tp.circuitIndex;
    this.yourId = tp.circuitId;
    const proposed = info[0] ?? this.window;
    this.window = Math.min(proposed || this.window, this.window);
    this.tx(
      {
        circuitIndex: this.yourIndex,
        circuitId: this.yourId,
        txSeq: this.myIndex,
        rxSeq: this.myId,
        opcode: NrOp.ConnAck,
        flags: 0,
      },
      new Uint8Array([this.window]),
    );
    this.to("connected");
    this.pump();
  }
  private onConnAck(tp: NrTransport, info: Uint8Array): void {
    if (this.state !== "connecting") return;
    if (tp.opcode & 0x80) {
      this.disarm();
      this.to("disconnected");
      return;
    } // refuse (defensive; opcode masked to nibble upstream)
    // their circuit id is echoed in the txSeq/rxSeq slots of the ack
    this.yourIndex = tp.txSeq;
    this.yourId = tp.rxSeq;
    // Never adopt a zero window — it would wedge pump() forever. Clamp to ≥1.
    this.window = Math.max(1, Math.min(info[0] || this.window, this.window));
    this.disarm(); // connect acknowledged
    this.to("connected");
    this.pump();
  }
  private onDiscReq(): void {
    this.tx(
      { circuitIndex: this.yourIndex, circuitId: this.yourId, txSeq: 0, rxSeq: 0, opcode: NrOp.DiscAck, flags: 0 },
      new Uint8Array(),
    );
    this.disarm();
    this.to("disconnected");
  }
  private onDiscAck(): void {
    if (this.state === "disconnecting") {
      this.disarm();
      this.to("disconnected");
    }
  }

  private onInfo(tp: NrTransport, info: Uint8Array): void {
    if (this.state !== "connected") return;
    if (tp.txSeq === this.vr) {
      // in-sequence
      this.vr = (this.vr + 1) % MOD;
      this.rxFrag.push(info);
      if (!(tp.flags & NR_MORE)) {
        // last fragment → reassemble + deliver
        const total = this.rxFrag.reduce((n, f) => n + f.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const f of this.rxFrag) {
          out.set(f, o);
          o += f.length;
        }
        this.rxFrag = [];
        this.ev.deliver(out);
      }
    }
    // cumulative ack of everything received so far
    this.tx(
      {
        circuitIndex: this.yourIndex,
        circuitId: this.yourId,
        txSeq: 0,
        rxSeq: this.vr,
        opcode: NrOp.InfoAck,
        flags: 0,
      },
      new Uint8Array(),
    );
  }
  private onInfoAck(tp: NrTransport): void {
    this.choked = !!(tp.flags & NR_CHOKE);
    // advance V(A) up to the acked rxSeq; drop acked frames
    while (this.va !== tp.rxSeq && this.sent.length && this.sent[0]!.seq === this.va) {
      this.sent.shift();
      this.va = (this.va + 1) % MOD;
    }
    if (this.sent.length)
      this.armFresh(); // progress made, more still outstanding → reset the timer
    else this.disarm(); // everything acked → nothing to time
    if (this.state === "connected" && !this.choked) this.pump();
  }

  // ----------------------------------------------------------------- send engine
  private pump(): void {
    while (!this.choked && this.txq.length && this.outstanding() < this.window) {
      const { info, more } = this.txq.shift()!;
      const seq = this.vs;
      this.vs = (this.vs + 1) % MOD;
      this.sent.push({ seq, info, more });
      this.tx(
        {
          circuitIndex: this.yourIndex,
          circuitId: this.yourId,
          txSeq: seq,
          rxSeq: this.vr,
          opcode: NrOp.Info,
          flags: more ? NR_MORE : 0,
        },
        info,
      );
    }
    if (this.sent.length && !this.t1) this.armFresh(); // have outstanding, no timer yet → start one
  }
  private outstanding(): number {
    return (this.vs - this.va + MOD) % MOD;
  }

  private tx(tp: NrTransport, info: Uint8Array): void {
    this.ev.send({ tp, info });
  }
  private to(s: CircuitState): void {
    if (s !== this.state) {
      const prev = this.state;
      this.state = s;
      this.ev.state(s, prev);
    }
  }

  /** Decode a ConnReq info field into the originating user/node calls (for a node accepting a circuit). */
  static originOf(info: Uint8Array): { window: number; user: Ax25Address; node: Ax25Address } | null {
    if (info.length < 15) return null;
    return { window: info[0]!, user: decodeAddress(info, 1).addr, node: decodeAddress(info, 8).addr };
  }
}
