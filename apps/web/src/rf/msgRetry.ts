// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * msgRetry.ts — the browser radio's message repeats. A numbered message sent from this tab's radio is sent again
 * until the addressee's station acks or rejects it (`MessageRetrier` in @aprscaching/aprs: 30 s, 1, 2 and 4 min
 * apart, 5 tries; from 2 min doubling to 30 min, 10 tries, on an HF link). The repeats run only while this tab is
 * open, its radio connected and transmitting allowed: the browser radio is bound to the session, so closing the
 * tab, disconnecting the radio or switching transmit off stops them. Every repeat is a transmission in the
 * Recent transmissions list, and each message's tries and outcome go to the instance for the Messages list.
 */
import { MessageRetrier, type PendingRetry, type RetryOutcome, type RetryStats } from "@aprscaching/aprs";
import type { TxFeature } from "./txLog.js";

/** The frame a message went out in, kept to send it again. */
export interface RetryFrame {
  src: string;
  dst: string;
  path: string[];
  payload: string;
}

export interface BrowserRetryDeps {
  now: () => number;
  /** The radio can transmit now as this call: a live link, the tab's consent, a verified call. */
  canTransmit: (call: string) => boolean;
  transmit: (f: RetryFrame, feature: TxFeature) => Promise<void>;
  /** A message settled: tell the instance how often it went out and how it ended. */
  report: (m: { from: string; to: string; text: string; msgNo: string; tries: number; outcome: RetryOutcome }) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
}

interface Kept {
  frame: RetryFrame;
  text: string;
  feature: TxFeature;
}

const TICK_MS = 5000;

/** The browser radio's repeating messages, with totals and a subscription for the views that show them. */
export class BrowserRetry {
  private retrier: MessageRetrier;
  private kept = new Map<string, Kept>();
  private subs = new Set<() => void>();
  private timer: unknown = null;
  private seq = 0;
  private snap: { waiting: number; stats: RetryStats };

  constructor(private deps: BrowserRetryDeps) {
    this.retrier = new MessageRetrier({
      now: deps.now,
      resend: (m) => this.resend(m),
      onSettle: (m, outcome) => this.settled(m, outcome),
    });
    this.snap = this.snapshot();
  }

  /** A numbered message this tab's radio just sent: repeat it until it is acked. */
  track(m: { to: string; text: string; msgNo: string; frame: RetryFrame; feature: TxFeature; hf?: boolean }): void {
    const ref = String(++this.seq);
    this.kept.set(ref, { frame: m.frame, text: m.text, feature: m.feature });
    this.retrier.track({ from: m.frame.src, to: m.to, msgNo: m.msgNo, hf: m.hf, ref });
    if (this.timer == null && this.deps.setInterval) this.timer = this.deps.setInterval(() => this.tick(), TICK_MS);
    this.changed();
  }

  /** A frame the radio heard: an ack or rej from an addressee settles its message. */
  heard(src: string, payload: string): void {
    if (this.retrier.heard(src, payload)) this.changed();
  }

  /** Send the repeats that are due. */
  tick(): void {
    const before = this.retrier.stats.retries;
    this.retrier.tick();
    if (this.retrier.stats.retries !== before) this.changed();
  }

  /** The radio went away or transmit was switched off: the repeats stop. */
  stopAll(): void {
    this.retrier.cancel();
  }

  getSnapshot = (): { waiting: number; stats: RetryStats } => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  private resend(m: PendingRetry): "sent" | "held" | "stop" {
    const k = this.kept.get(String(m.ref));
    if (!k || !this.deps.canTransmit(k.frame.src)) return "stop";
    // the frame goes out on its own; a failed send shows in the radio's toasts, and the next try follows
    void this.deps.transmit(k.frame, k.feature).catch(() => {});
    return "sent";
  }

  private settled(m: PendingRetry, outcome: RetryOutcome): void {
    const k = this.kept.get(String(m.ref));
    this.kept.delete(String(m.ref));
    if (k) this.deps.report({ from: m.from, to: m.to, text: k.text, msgNo: m.msgNo, tries: m.tries, outcome });
    if (!this.retrier.waiting && this.timer != null) {
      this.deps.clearInterval?.(this.timer);
      this.timer = null;
    }
    this.changed();
  }

  private snapshot() {
    return { waiting: this.retrier.waiting, stats: { ...this.retrier.stats } };
  }

  private changed(): void {
    this.snap = this.snapshot();
    for (const fn of this.subs) fn();
  }
}
