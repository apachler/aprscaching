// SPDX-License-Identifier: MIT
/**
 * fbb-scheduler.ts — the FBB forwarding scheduler brain, pure + I/O-free. On each tick it
 * asks the gateway (`ForwardApi`) for partners, picks the due ones (`partnerDue`), and per partner runs an
 * FBB session (`FbbForwarder`) over a connected-mode `ForwardLink`, reconciling the results back: pull the
 * pool, push inbound, mark sent. Both the gateway API and the link are injected, so the whole loop is
 * exercised headlessly (loopback link + in-memory api); the ingest supplies the fetch/KISS implementations.
 */
import { FbbForwarder } from "./fbb-forward.js";
import { partnerDue } from "./forward-schedule.js";
import type { FbbMessage, FbbStore } from "./fbb-session.js";

/** A forwarding partner as returned by the gateway `/api/bbs/partners`. */
export interface GwPartner {
  id: number; call: string; ha: string | null; connectScript: string;
  proto: "rf-fbb" | "axudp" | "ip-fed"; intervalMin: number; timebands: string;
  requestReverse: boolean; msgtypes: string; maxBlock: number; enabled: boolean;
}

/** The gateway forwarding-pool API the scheduler drives (implemented over REST by the ingest). */
export interface ForwardApi {
  partners(): Promise<GwPartner[]>;
  pool(call: string): Promise<FbbMessage[]>;
  inbound(message: FbbMessage, origin: string): Promise<void>;
  markSent(partner: string, bids: string[]): Promise<void>;
}

/** A connected-mode byte duplex to a partner: connect, exchange bytes, close. */
export interface ForwardLink {
  connect(): Promise<void>;
  send(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  disconnect(): void;
}
export type LinkFactory = (partner: GwPartner) => ForwardLink;

const SESSION_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 30_000;   // SR-PKT-07: a partner that never answers must not block the slot forever

/** Per-session FbbStore over a pool snapshot: the outbound queue drains as messages are sent; inbound is
 *  buffered and flushed to the gateway after the session (which dedups by BID). */
export class SessionStore implements FbbStore {
  readonly inbox: FbbMessage[] = [];
  readonly sentBids: string[] = [];
  constructor(private queue: FbbMessage[]) {}
  outbound(): FbbMessage[] { return this.queue; }
  hasBid(): boolean { return false; }                 // accept inbound; the gateway INSERT-OR-IGNORE dedups by BID
  accept(m: FbbMessage): void { this.inbox.push(m); }
  sent(bid: string): void {
    this.sentBids.push(bid);
    const i = this.queue.findIndex((q) => q.bid === bid);
    if (i >= 0) this.queue.splice(i, 1);
  }
}

export interface ForwarderOpts {
  api: ForwardApi; linkFactory: LinkFactory;
  pollMs?: number; sid?: string; now?: () => number; sessionTimeoutMs?: number; connectTimeoutMs?: number;
}

export class BbsForwarder {
  private lastRun = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = new Set<string>();
  private now: () => number;

  constructor(private o: ForwarderOpts) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.o.pollMs ?? 60_000);
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** One scheduler pass: forward every partner that is due now. */
  async tick(): Promise<void> {
    let partners: GwPartner[];
    try { partners = await this.o.api.partners(); } catch (e) { console.error("[forward] partner poll failed:", (e as Error).message); return; }
    const nowSec = this.now();
    for (const p of partners.filter((x) => x.proto === "rf-fbb" || x.proto === "axudp")) {
      if (this.busy.has(p.call)) continue;
      if (!partnerDue(p, this.lastRun.get(p.call) ?? null, nowSec)) continue;
      this.lastRun.set(p.call, nowSec);
      this.busy.add(p.call);
      try { await this.runSession(p); }
      catch (e) { console.error(`[forward] ${p.call} session failed:`, (e as Error).message); }
      finally { this.busy.delete(p.call); }
    }
  }

  /** Run one FBB forwarding session with a partner and reconcile the results back to the gateway. */
  async runSession(p: GwPartner): Promise<{ forwarded: number; received: number }> {
    const store = new SessionStore(await this.o.api.pool(p.call));
    const fwd = new FbbForwarder(store, { initiator: true, sid: this.o.sid });
    const link = this.o.linkFactory(p);

    // SR-PKT-07: bound the connect. If it never settles, disconnect and throw so `busy` is released
    // (the caller's finally) instead of the partner being wedged forever.
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      link.connect(),
      new Promise<void>((_res, rej) => { connectTimer = setTimeout(() => { link.disconnect(); rej(new Error("connect timeout")); }, this.o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS); }),
    ]).finally(() => { if (connectTimer !== null) clearTimeout(connectTimer); });

    // SR-PKT-03: only reconcile `markSent` when the session ended cleanly (FQ). On a timeout or abnormal
    // close mid-body the messages were NOT delivered — leave them queued (BID dedup makes re-send safe).
    let cleanDone = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(() => { link.disconnect(); finish(); }, this.o.sessionTimeoutMs ?? SESSION_TIMEOUT_MS);
      link.onClose(() => { clearTimeout(timer); finish(); });
      link.onData((bytes) => {
        const out = fwd.onData(bytes);
        if (out) link.send(out);
        if (fwd.done) { cleanDone = true; clearTimeout(timer); link.disconnect(); finish(); }
      });
      const open = fwd.start();
      if (open) link.send(open);
    });

    for (const m of store.inbox) await this.o.api.inbound(m, `rf-fbb:${p.call}`);
    if (cleanDone) await this.o.api.markSent(p.call, store.sentBids);
    return { forwarded: cleanDone ? store.sentBids.length : 0, received: store.inbox.length };
  }
}
