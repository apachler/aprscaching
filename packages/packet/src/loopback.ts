// SPDX-License-Identifier: MIT
/**
 * loopback.ts — an in-memory simulated radio channel for exercising the connected-mode packet stack
 * (BBS / NET/ROM node / forwarding) with NO hardware. The sim analogue of a real KISS link:
 * two AX.25 endpoints are wired so a frame one side transmits is delivered to the other's `onReceive`.
 * Delivery is deferred and FIFO — a transmitted frame is queued, not handed to the peer inside the same
 * `send()` call — so it can't re-enter the sender's state machine mid-transition (exactly like a real
 * radio, where the reply arrives on a later turn). The host drains the queue with `pump()`. This is what
 * lets F1/F2/F4 be validated headlessly; the ingest swaps this for a real TNC at deploy. Optional frame
 * loss models a lossy channel for recovery tests.
 */
import type { Ax25Frame } from "@aprscaching/ax25";

type Rx = (f: Ax25Frame) => void;

/** A monotonic virtual clock the harness advances explicitly, so connected-mode timers are deterministic. */
export class VirtualClock {
  private t = 0;
  time = (): number => this.t;
  /** Advance `ms`, calling `poll` every `step` ms so T1/T3 deadlines fire in order. */
  advance(ms: number, poll: () => void, step = 250): void {
    for (let e = 0; e < ms; e += step) {
      this.t += Math.min(step, ms - e);
      poll();
    }
  }
}

/**
 * A simulated channel joining two endpoints (A ↔ B). Register each endpoint's `onReceive` with
 * `attach()`, and give each side `sendFromA`/`sendFromB` as its link's `send`. A transmitted frame is
 * QUEUED, not delivered inline — call `pump()` to drain the queue (delivering frames may queue replies,
 * which `pump()` keeps draining until the channel is idle). Returns the number of frames delivered.
 */
export class LoopbackChannel {
  private a: Rx | null = null;
  private b: Rx | null = null;
  private q: Array<[Rx | null, Ax25Frame]> = [];
  /** Optional: drop the Nth transmitted frame(s) to model loss (indices are per-direction send order). */
  drop: (from: "A" | "B", n: number) => boolean = () => false;
  private nA = 0;
  private nB = 0;

  attach(a: Rx, b: Rx): void {
    this.a = a;
    this.b = b;
  }
  sendFromA = (f: Ax25Frame): void => {
    if (!this.drop("A", this.nA++)) this.q.push([this.b, f]);
  };
  sendFromB = (f: Ax25Frame): void => {
    if (!this.drop("B", this.nB++)) this.q.push([this.a, f]);
  };

  /** Deliver all queued frames (and any they trigger), FIFO, until the channel is idle. */
  pump(guard = 10000): number {
    let n = 0;
    while (this.q.length && n < guard) {
      const [rx, fr] = this.q.shift()!;
      rx?.(fr);
      n++;
    }
    return n;
  }
}
