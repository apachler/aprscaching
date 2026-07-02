// SPDX-License-Identifier: MIT
/**
 * fbb-session.ts — the FBB ASCII forwarding session (docs/29 F4), reimplemented from the F6FBB protocol
 * spec. Two BBSes exchange personal/bulletin mail over a connected AX.25 link with **reverse forwarding**:
 * after each block the send direction flips. Pure + line-oriented (no I/O) — the ingest drives it over a
 * real ConnectedLink; the loopback harness drives it headlessly. ASCII-first; the binary B0/B1 (LZHUF)
 * modes are a documented follow-on (`docs/29`). This is the interop bridge to the classic packet network.
 *
 * Wire recap (F6FBB): SID advertises the `F` flag; proposal `FB <type> <FROM> <@AT> <TO> <BID> <size>`
 * (≤5/block) then `F>`; reply `FS ±=…` (+ accept, - reject, = defer); each accepted message is sent as
 * `title` line, body lines, then a `^Z` (0x1A) line; `FF` = nothing to send; `FQ` = done → disconnect.
 */
import { parseProposal, parseFS, type Proposal } from "./forward.js";

export interface FbbMessage { type: "P" | "B"; from: string; at: string; to: string; bid: string; title: string; body: string }

/** The message store a forwarding session reads outbound from and writes inbound to. */
export interface FbbStore {
  outbound(): FbbMessage[];      // messages queued to forward to this partner (oldest first)
  hasBid(bid: string): boolean;  // already held? → reject the proposal
  accept(m: FbbMessage): void;   // store an accepted inbound message
  sent(bid: string): void;       // an outbound message was forwarded (dequeue it)
}

const CTRLZ = "\x1a";
const MAX_BLOCK = 5;

type Phase = "await-sid" | "await-fs" | "recv-block" | "await-proposals" | "done";

/** One side of an FBB forwarding session. Feed it received lines; it returns lines to send. */
export class FbbSession {
  private phase: Phase;
  private sentSid = false;
  private offered: Proposal[] = [];         // what we last proposed (awaiting FS)
  private accepting: Proposal[] = [];        // inbound proposals we accepted, awaiting their bodies
  private rxAcc: string[] = [];              // body lines of the message currently being received
  private rxTitle: string | null = null;
  private pendingRx: Proposal[] = [];        // accepted inbound proposals whose bodies we're awaiting

  constructor(private store: FbbStore, private opts: { initiator: boolean; sid?: string }) {
    this.phase = opts.initiator ? "await-sid" : "await-sid";
  }

  private sid(): string { return this.opts.sid ?? "[ACG-1.0-F$]"; }

  /** Lines to send when the link comes up. The initiator opens with its SID (+ first block). */
  start(): string[] {
    if (!this.opts.initiator) return [];
    this.sentSid = true;
    return [this.sid(), ...this.proposeBlock()];
  }

  /** Build our next proposal block (≤5), or ["FF"] when we have nothing to send. Sets await-fs. */
  private proposeBlock(): string[] {
    const out = this.store.outbound().slice(0, MAX_BLOCK);
    if (out.length === 0) { this.phase = "await-proposals"; return ["FF"]; }
    this.offered = out.map((m) => ({ type: m.type, from: m.from, atBbs: m.at, to: m.to, bid: m.bid, size: m.body.length }));
    this.phase = "await-fs";
    const lines = this.offered.map((p) => `FB ${p.type} ${p.from} ${p.atBbs} ${p.to} ${p.bid} ${p.size}`);
    lines.push("F>");
    return lines;
  }

  /** Serialise the messages the peer accepted (FS '+'), each as title / body / ^Z. */
  private sendAccepted(verdicts: ("accept" | "reject" | "defer")[]): string[] {
    const out: string[] = [];
    const queued = this.store.outbound();
    this.offered.forEach((p, i) => {
      const v = verdicts[i];
      if (v === "defer") return;                       // '=' → keep queued, offer again next time
      if (v === "accept") {                            // '+' → send the body
        const m = queued.find((q) => q.bid === p.bid);
        if (m) out.push(m.title, ...m.body.split("\n"), CTRLZ);
      }
      this.store.sent(p.bid);                           // accepted or rejected → done forwarding to this partner
    });
    this.offered = [];
    // after our block, the direction reverses — the peer now proposes to us
    this.phase = "await-proposals";
    return out;
  }

  /** Process one received line; returns lines to send + a `done` flag (disconnect after FQ). */
  feed(line: string): { out: string[]; done?: boolean } {
    const raw = line.replace(/[\r\n]+$/, "");
    const t = raw.trim();

    if (this.phase === "await-sid") {
      if (!/\[.*\]/.test(t)) return { out: [] };             // still waiting for their SID
      // responder replies with its SID, then (as the peer proposed first) waits for proposals
      const out = this.opts.initiator ? [] : (this.sentSid = true, [this.sid()]);
      this.phase = "await-proposals";
      return { out };
    }

    if (this.phase === "await-fs") {
      if (!/^FS/i.test(t)) return { out: [] };
      return { out: this.sendAccepted(parseFS(t)) };
    }

    if (this.phase === "await-proposals") {
      if (/^FQ/i.test(t)) { this.phase = "done"; return { out: [], done: true }; }
      if (/^FF/i.test(t)) {                                   // peer has nothing; our turn (or we're both done)
        const mine = this.proposeBlock();
        if (mine.length === 1 && mine[0] === "FF") { this.phase = "done"; return { out: ["FQ"], done: true }; }
        return { out: mine };
      }
      const p = parseProposal(t);
      if (p) { this.accepting.push(p); return { out: [] }; }  // collecting FB lines
      if (/^F>/.test(t)) {                                    // proposal block complete → answer FS, then receive
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

    // phase === "recv-block": read title / body / ^Z for each accepted message, in order
    if (this.rxTitle === null && t !== CTRLZ && raw !== CTRLZ) { this.rxTitle = raw; return { out: [] }; }
    if (raw === CTRLZ || t === CTRLZ) {
      const p = this.pendingRx.shift()!;
      this.store.accept({ type: p.type === "T" ? "P" : p.type, from: p.from, at: p.atBbs, to: p.to, bid: p.bid, title: this.rxTitle ?? "", body: this.rxAcc.join("\n") });
      this.rxTitle = null; this.rxAcc = [];
      if (this.pendingRx.length === 0) return { out: this.turnToPropose() }; // block done → reverse
      return { out: [] };
    }
    this.rxAcc.push(raw);
    return { out: [] };
  }

  /** After receiving a block we become the sender: propose our block (or FF). */
  private turnToPropose(): string[] { return this.proposeBlock(); }
}
