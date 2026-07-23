// SPDX-License-Identifier: MIT
/**
 * fbb-session.ts — the FBB ASCII forwarding session, reimplemented from the F6FBB protocol
 * spec. Two BBSes exchange personal/bulletin mail over a connected AX.25 link with **reverse forwarding**:
 * after each block the send direction flips. Pure + line-oriented (no I/O) — the ingest drives it over a
 * real ConnectedLink; the loopback harness drives it headlessly. ASCII-first; the binary B0/B1 (LZHUF)
 * modes are a documented follow-on. This is the interop bridge to the classic packet network.
 *
 * Wire recap (F6FBB): SID advertises the `F` flag; proposal `FB <type> <FROM> <@AT> <TO> <BID> <size>`
 * (≤5/block) then `F>`; reply `FS ±=…` (+ accept, - reject, = defer); each accepted message is sent as
 * `title` line, body lines, then a `^Z` (0x1A) line; `FF` = nothing to send; `FQ` = done → disconnect.
 */
import { parseProposal, parseFSDetailed, buildProposalFA, type Proposal, type FsVerdict } from "./forward.js";
import {
  encodeFbbCompressed,
  decodeFbbCompressed,
  compressionAgreed,
  sidHasCompression,
  type BinaryTransfer,
} from "./fbb-binary.js";

export interface FbbMessage {
  type: "P" | "B";
  from: string;
  at: string;
  to: string;
  bid: string;
  title: string;
  body: string;
}

/** The message store a forwarding session reads outbound from and writes inbound to. */
export interface FbbStore {
  outbound(): FbbMessage[]; // messages queued to forward to this partner (oldest first)
  hasBid(bid: string): boolean; // already held? → reject the proposal
  accept(m: FbbMessage): void; // store an accepted inbound message
  sent(bid: string): void; // an outbound message was forwarded (dequeue it)
}

const CTRLZ = "\x1a";
const MAX_BLOCK = 5;
/** A peer that streams a body and never sends ^Z must not grow `rxAcc` without bound.
 *  Cap the received body at the larger of the peer's own proposed `size` (with slack) and a floor,
 *  but never past this hard ceiling — beyond it the block is hostile/broken and we abort the session. */
const MAX_RECV_BYTES = 64 * 1024;

type Phase = "await-sid" | "await-fs" | "recv-block" | "await-proposals" | "done";

/** One side of an FBB forwarding session. Feed it received lines; it returns lines to send. */
export class FbbSession {
  private phase: Phase;
  private sentSid = false;
  private offered: Proposal[] = []; // what we last proposed (awaiting FS)
  private accepting: Proposal[] = []; // inbound proposals we accepted, awaiting their bodies
  private rxAcc: string[] = []; // body lines of the message currently being received
  private rxTitle: string | null = null;
  private rxBytes = 0; // running size of the current inbound body (OOM guard)
  private pendingRx: Proposal[] = []; // accepted inbound proposals whose bodies we're awaiting
  private compressed = false; // negotiated: both SIDs advertise the B flag → bodies travel as LZHUF-B1 blocks
  private pendingBinary: Uint8Array[] = []; // encoded binary transfers to transmit (drained by the byte layer)

  constructor(
    private store: FbbStore,
    private opts: { initiator: boolean; sid?: string; sidAlreadySent?: boolean; compress?: boolean },
  ) {
    this.phase = opts.initiator ? "await-sid" : "await-sid";
  }

  private sid(): string {
    // Advertise the B (compressed) flag when we're willing to forward compressed, so the peer can agree.
    const base = this.opts.sid ?? (this.opts.compress ? "[ACG-1.0-BF$]" : "[ACG-1.0-F$]");
    if (!this.opts.compress || sidHasCompression(base)) return base;
    // A custom SID without B would silently disable the compression we offer — inject it into the flags.
    return base.replace(/-([A-Za-z0-9]*\$?)\]\s*$/, (m, flags) => `-B${flags}]`);
  }

  /** True once both stations' SIDs have agreed to compressed (LZHUF-B1) forwarding. */
  isCompressed(): boolean {
    return this.compressed;
  }

  /** How many binary message transfers to read next (the byte layer switches to block mode for these). */
  expectingBinary(): number {
    return this.compressed && this.phase === "recv-block" ? this.pendingRx.length : 0;
  }

  /** Drain the encoded binary transfers queued for transmission (compressed-mode message bodies). */
  takeBinary(): Uint8Array[] {
    const out = this.pendingBinary;
    this.pendingBinary = [];
    return out;
  }

  /** Lines to send when the link comes up. The initiator opens with its SID; in compressed mode it holds
   *  its first proposal block until it has seen the peer's SID (so it knows whether to offer FA or FB). */
  start(): string[] {
    if (!this.opts.initiator) return [];
    this.sentSid = true;
    if (this.opts.compress) return [this.sid()];
    return [this.sid(), ...this.proposeBlock()];
  }

  /** Build our next proposal block (≤5), or ["FF"] when we have nothing to send. Sets await-fs. */
  private proposeBlock(): string[] {
    const out = this.store.outbound().slice(0, MAX_BLOCK);
    if (out.length === 0) {
      this.phase = "await-proposals";
      return ["FF"];
    }
    // FB lines are space-delimited: a field with inner whitespace (a mis-shaped store entry) would
    // emit an unparseable proposal and deadlock the exchange — keep each field a single token.
    const tok = (s: string) => s.trim().split(/\s+/)[0] ?? s;
    this.offered = out.map((m) => ({
      type: m.type,
      from: tok(m.from),
      atBbs: tok(m.at),
      to: tok(m.to),
      bid: tok(m.bid),
      size: m.body.length,
    }));
    this.phase = "await-fs";
    // FA (compressed) or FB (ASCII) proposals, same field order.
    const lines = this.compressed
      ? buildProposalFA(this.offered)
      : this.offered.map((p) => `FB ${p.type} ${p.from} ${p.atBbs} ${p.to} ${p.bid} ${p.size}`);
    if (!this.compressed) lines.push("F>");
    return lines;
  }

  /** Serialise the accepted messages: ASCII sends title / body / ^Z; compressed queues LZHUF-B1 blocks. */
  private sendAccepted(verdicts: FsVerdict[]): string[] {
    const out: string[] = [];
    const queued = this.store.outbound();
    this.offered.forEach((p, i) => {
      const fs = verdicts[i];
      const v = fs?.verdict;
      // A short/garbled FS reply leaves later verdicts undefined. Only an EXPLICIT accept or
      // reject dequeues the message; anything else ('=' defer, missing, unknown) keeps it queued so a
      // truncated `FS +` to a 5-proposal block can't silently drop the other four.
      if (v !== "accept" && v !== "reject") return;
      if (v === "accept") {
        const m = queued.find((q) => q.bid === p.bid);
        if (m) {
          if (this.compressed)
            this.pendingBinary.push(encodeFbbCompressed({ title: m.title, body: m.body, offset: fs?.offset }));
          else out.push(m.title, ...m.body.split("\n"), CTRLZ);
        }
      }
      this.store.sent(p.bid); // accepted or rejected → done forwarding to this partner
    });
    this.offered = [];
    // after our block, the direction reverses — the peer now proposes to us
    this.phase = "await-proposals";
    return out;
  }

  /** Consume a decoded binary (compressed) message transfer during a compressed recv-block. Returns the
   *  reverse-forward lines once the whole accepted block has arrived. A CRC/checksum failure drops the
   *  message (it stays queued at the sender and is re-proposed) rather than storing corruption. */
  feedBinary(t: BinaryTransfer): string[] {
    if (this.phase !== "recv-block") return [];
    const p = this.pendingRx.shift();
    if (p) {
      const { title, body, crcOk } = decodeFbbCompressed(t);
      if (crcOk)
        this.store.accept({
          type: p.type === "T" ? "P" : p.type,
          from: p.from,
          at: p.atBbs,
          to: p.to,
          bid: p.bid,
          title,
          body,
        });
    }
    if (this.pendingRx.length === 0) {
      this.phase = "await-proposals";
      return this.turnToPropose(); // block done → reverse
    }
    return [];
  }

  /** Process one received line; returns lines to send + a `done` flag (disconnect after FQ). */
  feed(line: string): { out: string[]; done?: boolean } {
    const raw = line.replace(/[\r\n]+$/, "");
    const t = raw.trim();

    if (this.phase === "await-sid") {
      if (!/\[.*\]/.test(t)) return { out: [] }; // still waiting for their SID
      // Compression runs only when BOTH SIDs advertise the B flag.
      this.compressed = !!this.opts.compress && compressionAgreed(this.sid(), t);
      // Responder replies with its SID, then (as the peer proposed first) waits for proposals.
      // A real called BBS greets with its SID BEFORE the caller speaks (the FBB wire order) —
      // when that greeting already carried it (sidAlreadySent), answering again would double-send.
      const sidReply =
        this.opts.initiator || this.opts.sidAlreadySent || this.sentSid ? [] : ((this.sentSid = true), [this.sid()]);
      // The compressed initiator held its first proposal block until it saw the peer's SID — send it now.
      if (this.opts.initiator && this.opts.compress) return { out: this.proposeBlock() };
      this.phase = "await-proposals";
      return { out: sidReply };
    }

    if (this.phase === "await-fs") {
      if (!/^FS/i.test(t)) return { out: [] };
      return { out: this.sendAccepted(parseFSDetailed(t)) };
    }

    if (this.phase === "await-proposals") {
      if (/^FQ/i.test(t)) {
        this.phase = "done";
        return { out: [], done: true };
      }
      if (/^FF/i.test(t)) {
        // peer has nothing; our turn (or we're both done)
        const mine = this.proposeBlock();
        if (mine.length === 1 && mine[0] === "FF") {
          this.phase = "done";
          return { out: ["FQ"], done: true };
        }
        return { out: mine };
      }
      const p = parseProposal(t);
      if (p) {
        this.accepting.push(p);
        return { out: [] };
      } // collecting FB lines
      if (/^F>/.test(t)) {
        // proposal block complete → answer FS, then receive
        const verdicts = this.accepting.map((pr) => (this.store.hasBid(pr.bid) ? "-" : "+"));
        this.pendingRx = this.accepting.filter((_, i) => verdicts[i] === "+");
        this.accepting = [];
        this.phase = this.pendingRx.length ? "recv-block" : "await-proposals";
        const fs = `FS ${verdicts.join("")}`;
        // if we accepted nothing, it's immediately our turn to propose back
        return { out: this.pendingRx.length ? [fs] : [fs, ...this.turnToPropose()] };
      }
      return { out: [] };
    }

    // any line after FQ (or in an unexpected state) is ignored — a hostile peer sending
    // "FQ\r^Z\r" must not reach the recv-block code below (pendingRx is empty there)
    if (this.phase !== "recv-block") return { out: [] };
    // In compressed mode the body is a binary block stream fed via feedBinary(), not lines — ignore any
    // line that surfaces here (block bytes never reach feed(); the byte layer routes them to feedBinary).
    if (this.compressed) return { out: [] };

    // phase === "recv-block": read title / body / ^Z for each accepted message, in order
    if (this.rxTitle === null && t !== CTRLZ && raw !== CTRLZ) {
      this.rxTitle = raw;
      return { out: [] };
    }
    if (raw === CTRLZ || t === CTRLZ) {
      const p = this.pendingRx.shift();
      if (!p) {
        this.rxTitle = null;
        this.rxAcc = [];
        this.rxBytes = 0;
        this.phase = "await-proposals";
        return { out: [] };
      }
      this.store.accept({
        type: p.type === "T" ? "P" : p.type,
        from: p.from,
        at: p.atBbs,
        to: p.to,
        bid: p.bid,
        title: this.rxTitle ?? "",
        body: this.rxAcc.join("\n"),
      });
      this.rxTitle = null;
      this.rxAcc = [];
      this.rxBytes = 0;
      if (this.pendingRx.length === 0) return { out: this.turnToPropose() }; // block done → reverse
      return { out: [] };
    }
    // Enforce the peer's own proposed size (with slack), never past the hard ceiling —
    // a never-terminated body must not buffer without bound.
    this.rxBytes += raw.length + 1;
    const proposed = this.pendingRx[0]?.size ?? 0;
    const limit = Math.min(MAX_RECV_BYTES, Math.max(proposed * 2 + 1024, 4096));
    if (this.rxBytes > limit) {
      this.rxTitle = null;
      this.rxAcc = [];
      this.rxBytes = 0;
      this.phase = "done";
      return { out: ["FQ"], done: true }; // over-size recv-block → abort the forwarding session
    }
    this.rxAcc.push(raw);
    return { out: [] };
  }

  /** After receiving a block we become the sender: propose our block (or FF). */
  private turnToPropose(): string[] {
    return this.proposeBlock();
  }
}
