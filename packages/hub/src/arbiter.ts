// SPDX-License-Identifier: MIT
/**
 * arbiter.ts — who transmits next on a shared radio port. Many applications share one radio; each hands frames
 * to the hub, and the arbiter queues them per port and per client and serves the clients of a port in turn, one
 * frame each, so a busy client cannot hold the channel while another waits.
 *
 * Every client has a budget over a sliding minute, counted across all ports: at most `framesPerMinute` frames and
 * `bytesPerMinute` bytes accepted. A frame past the budget is refused. A client's queue on a port holds at most
 * `maxQueue` frames; a new frame on a full queue drops that queue's oldest, since the newest is the one the
 * application still means. A queued frame older than `maxAgeMs` is dropped when its turn comes: a frame that
 * waited that long on a busy channel no longer answers anything. Every drop is counted per client and reason.
 *
 * The arbiter decides order and admission only. The transmit gate, the box's pacing and the radio's own channel
 * access come after it. Pure: the clock is passed in.
 */

/** Why a frame was refused or dropped. */
export type DropReason = "frame-budget" | "byte-budget" | "queue-full" | "stale";

export interface ArbiterOpts {
  /** Frames a client may have accepted within any minute. */
  framesPerMinute: number;
  /** Bytes a client may have accepted within any minute. */
  bytesPerMinute: number;
  /** Frames a client may have waiting on one port. */
  maxQueue: number;
  /** How long a frame may wait for its turn. */
  maxAgeMs: number;
  now?: () => number;
}

/** The defaults: ten frames and 4 KiB a minute per client, sixteen waiting per port, a minute's wait at most. */
export const ARBITER_DEFAULTS: Readonly<Omit<ArbiterOpts, "now">> = Object.freeze({
  framesPerMinute: 10,
  bytesPerMinute: 4096,
  maxQueue: 16,
  maxAgeMs: 60_000,
});

/** The result of offering a frame: whether it was queued, and what was refused or dropped because of it. */
export interface Offer {
  queued: boolean;
  dropped?: DropReason;
}

/** A frame whose turn has come. */
export interface Turn<C> {
  client: C;
  frame: Uint8Array;
}

const MINUTE = 60_000;

interface Queued {
  frame: Uint8Array;
  at: number;
}

/**
 * One port's rotation: the clients with a frame waiting, in the order they joined, and the index of the one whose
 * turn is next. A client whose queue empties leaves the ring; it joins at the end when it queues again.
 */
interface Rotation<C> {
  ring: C[];
  turn: number;
  queues: Map<C, Queued[]>;
}

export class TxArbiter<C = string> {
  private o: ArbiterOpts;
  private rotations = new Map<string, Rotation<C>>();
  /** Per client: what it had accepted within the last minute. */
  private spent = new Map<C, { at: number; bytes: number }[]>();
  private drops = new Map<C, Record<DropReason, number>>();

  constructor(opts: Partial<ArbiterOpts> = {}) {
    this.o = { ...ARBITER_DEFAULTS, ...opts };
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private count(client: C, reason: DropReason): void {
    let d = this.drops.get(client);
    if (!d) this.drops.set(client, (d = { "frame-budget": 0, "byte-budget": 0, "queue-full": 0, stale: 0 }));
    d[reason]++;
  }

  /** Offer a client's frame for a port. */
  offer(client: C, port: string, frame: Uint8Array): Offer {
    const now = this.now();
    const spent = (this.spent.get(client) ?? []).filter((s) => now - s.at < MINUTE);
    this.spent.set(client, spent);
    if (spent.length + 1 > this.o.framesPerMinute) {
      this.count(client, "frame-budget");
      return { queued: false, dropped: "frame-budget" };
    }
    if (spent.reduce((n, s) => n + s.bytes, 0) + frame.length > this.o.bytesPerMinute) {
      this.count(client, "byte-budget");
      return { queued: false, dropped: "byte-budget" };
    }
    spent.push({ at: now, bytes: frame.length });
    let r = this.rotations.get(port);
    if (!r) this.rotations.set(port, (r = { ring: [], turn: 0, queues: new Map() }));
    let q = r.queues.get(client);
    if (!q) {
      r.queues.set(client, (q = []));
      r.ring.push(client);
    }
    q.push({ frame, at: now });
    if (q.length > this.o.maxQueue) {
      q.shift();
      this.count(client, "queue-full");
      return { queued: true, dropped: "queue-full" };
    }
    return { queued: true };
  }

  /** The next frame for a port, from the client whose turn it is; null when none waits. */
  next(port: string): Turn<C> | null {
    const r = this.rotations.get(port);
    if (!r) return null;
    const now = this.now();
    while (r.ring.length) {
      const client = r.ring[r.turn]!;
      const q = r.queues.get(client)!;
      const item = q.shift()!;
      if (q.length) r.turn++;
      else {
        // the client leaves the ring, and the one after it moves up into this turn
        r.queues.delete(client);
        r.ring.splice(r.turn, 1);
      }
      // past the end of the ring the turn comes round to its start, before anyone joins at the end
      if (r.turn >= r.ring.length) r.turn = 0;
      if (now - item.at > this.o.maxAgeMs) {
        this.count(client, "stale");
        continue;
      }
      return { client, frame: item.frame };
    }
    return null;
  }

  /** Frames waiting on a port. */
  pending(port: string): number {
    let n = 0;
    for (const q of this.rotations.get(port)?.queues.values() ?? []) n += q.length;
    return n;
  }

  /** The ports a frame waits on. */
  ports(): string[] {
    return [...this.rotations.keys()].filter((p) => this.pending(p) > 0);
  }

  /** Forget a client that went away: its waiting frames, its budget and its counts (read them first). */
  remove(client: C): void {
    for (const r of this.rotations.values()) {
      const i = r.ring.indexOf(client);
      if (i < 0) continue;
      r.ring.splice(i, 1);
      r.queues.delete(client);
      if (i < r.turn) r.turn--;
      if (r.turn >= r.ring.length) r.turn = 0;
    }
    this.spent.delete(client);
    this.drops.delete(client);
  }

  /** A client's drops by reason. */
  dropped(client: C): Readonly<Record<DropReason, number>> {
    return this.drops.get(client) ?? { "frame-budget": 0, "byte-budget": 0, "queue-full": 0, stale: 0 };
  }
}
