// SPDX-License-Identifier: MIT
/**
 * msgretry.ts — repeating a numbered APRS message until its addressee acknowledges it (APRS 1.2, "Messages,
 * Bulletins and Announcements"). A message carries a number; the addressee's station answers `ackNN` or `rejNN`,
 * or carries the ack inside a message of its own in the reply-ack form `{MM}NN`. A sender that hears neither
 * sends the message again on a decaying schedule and gives up after its last try.
 *
 * VHF: five tries, 30 s, 1, 2 and 4 min apart, and 8 min to wait for the ack of the last. HF fades and shares one
 * 300-baud channel: ten tries, 2 min apart at first, the gap doubling up to 30 min. The engine is pure: the caller
 * sends, the caller feeds it what it hears, and its clock is injected.
 */
import { decodeAprs } from "./decode.js";

/** The gaps after each try, seconds; the last is how long the last try waits for its ack. */
export const RETRY_GAPS_VHF_SEC: readonly number[] = [30, 60, 120, 240, 480];
export const RETRY_GAPS_HF_SEC: readonly number[] = [120, 240, 480, 960, 1800, 1800, 1800, 1800, 1800, 1800];
/** How soon a try the radio could not take (pacing, a busy link) is attempted again, seconds. It counts no try. */
export const RETRY_HELD_SEC = 15;
/** At most this many messages wait for an ack at once; the oldest gives up for a newer one. */
export const RETRY_MAX_PENDING = 100;

/** What became of a message: its addressee acked or rejected it, it ran out of tries, or the sender stopped it. */
export type RetryOutcome = "acked" | "rejected" | "expired" | "cancelled";

/** One message the engine repeats. `from` is the call it went out under, `to` its addressee. */
export interface RetryMessage {
  from: string;
  to: string;
  msgNo: string;
  /** On an HF radio: the HF schedule applies. */
  hf?: boolean;
  /** The caller's own handle (a command id, a line in a list), returned with the outcome. */
  ref?: string | number;
}

export interface PendingRetry extends RetryMessage {
  /** Times the message went out, the first send included. */
  tries: number;
  /** When it first went out, and when the next try (or the give-up) is due, milliseconds. */
  firstAt: number;
  nextAt: number;
}

/** Running totals, for a status line. */
export interface RetryStats {
  /** Messages handed to the engine. */
  messages: number;
  /** Sends after the first. */
  retries: number;
  acked: number;
  rejected: number;
  expired: number;
  cancelled: number;
}

/** A try's result: it went out, the radio could not take it now (try again soon), or the sender must stop. */
export type TryResult = "sent" | "held" | "stop";

export interface MessageRetrierOpts {
  now: () => number;
  /** Send the message again. Every gate of a first send applies to a repeat too. */
  resend: (m: PendingRetry) => TryResult;
  /** A message is settled: it leaves the engine with this outcome. */
  onSettle?: (m: PendingRetry, outcome: RetryOutcome) => void;
  maxPending?: number;
}

const key = (from: string, to: string, msgNo: string) => `${from}|${to}|${msgNo}`.toUpperCase();
const gaps = (hf?: boolean) => (hf ? RETRY_GAPS_HF_SEC : RETRY_GAPS_VHF_SEC);

/** The longest a message waits from its first send to its give-up, milliseconds, held tries aside. */
export function retrySpanMs(hf?: boolean): number {
  return gaps(hf).reduce((a, b) => a + b, 0) * 1000;
}

/**
 * What an info field from `src` says about a message number: an ack or rej addressed to `addressee`, or a
 * message to it whose reply-ack acknowledges a number. A third-party frame (`}`) is read for its inner packet.
 */
export function ackOf(src: string, payload: string): { from: string; to: string; msgNo: string; rej: boolean } | null {
  let from = src;
  let info = payload;
  if (info.startsWith("}")) {
    const inner = /^\}([A-Za-z0-9-]{1,9})>[^:]*:(.*)$/s.exec(info);
    if (!inner) return null;
    from = inner[1]!;
    info = inner[2]!;
  }
  if (!info.startsWith(":")) return null;
  const d = decodeAprs({ src: from, dst: "", path: [], payload: info, raw: "" });
  if (d.kind !== "message" || !d.addressee) return null;
  const no = d.ack || d.rej ? d.msgNo : d.replyAck;
  if (!no) return null;
  return { from: from.toUpperCase(), to: d.addressee.trim().toUpperCase(), msgNo: String(no), rej: !!d.rej };
}

/** Repeats numbered messages until an ack or rej from their addressee settles them, or their tries run out. */
export class MessageRetrier {
  private pending = new Map<string, PendingRetry>();
  readonly stats: RetryStats = { messages: 0, retries: 0, acked: 0, rejected: 0, expired: 0, cancelled: 0 };

  constructor(private o: MessageRetrierOpts) {}

  /** Messages still waiting for an ack. */
  get waiting(): number {
    return this.pending.size;
  }

  list(): PendingRetry[] {
    return [...this.pending.values()];
  }

  /** A message just went out for the first time: repeat it until it is acked. The same message again restarts it. */
  track(m: RetryMessage): void {
    const now = this.o.now();
    const k = key(m.from, m.to, m.msgNo);
    this.pending.delete(k);
    const max = this.o.maxPending ?? RETRY_MAX_PENDING;
    while (this.pending.size >= max) {
      const oldest = this.pending.keys().next().value as string;
      this.settle(oldest, "cancelled");
    }
    this.stats.messages++;
    this.pending.set(k, { ...m, tries: 1, firstAt: now, nextAt: now + gaps(m.hf)[0]! * 1000 });
  }

  /**
   * A frame heard from `src`: an ack or rej from a message's addressee, for that message's number and addressed to
   * the call it went out under, settles it. True when it settled one.
   */
  heard(src: string, payload: string): boolean {
    const a = ackOf(src, payload);
    if (!a) return false;
    const k = key(a.to, a.from, a.msgNo);
    if (!this.pending.has(k)) return false;
    this.settle(k, a.rej ? "rejected" : "acked");
    return true;
  }

  /** Stop every message from `from` (every one when absent): the sender may no longer transmit. */
  cancel(from?: string): void {
    for (const [k, m] of [...this.pending])
      if (!from || m.from.toUpperCase() === from.toUpperCase()) this.settle(k, "cancelled");
  }

  /** Send the tries that are due and give up on the messages whose last try went unanswered. */
  tick(): void {
    const now = this.o.now();
    for (const [k, m] of [...this.pending]) {
      if (now < m.nextAt) continue;
      const g = gaps(m.hf);
      if (m.tries >= g.length || now - m.firstAt > retrySpanMs(m.hf) + 3600_000) {
        this.settle(k, "expired");
        continue;
      }
      const r = this.o.resend(m);
      if (r === "stop") this.settle(k, "cancelled");
      else if (r === "held") m.nextAt = now + RETRY_HELD_SEC * 1000;
      else {
        this.stats.retries++;
        m.tries++;
        m.nextAt = now + g[m.tries - 1]! * 1000;
      }
    }
  }

  private settle(k: string, outcome: RetryOutcome): void {
    const m = this.pending.get(k);
    if (!m) return;
    this.pending.delete(k);
    this.stats[outcome]++;
    this.o.onSettle?.(m, outcome);
  }
}
