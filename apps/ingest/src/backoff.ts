// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * backoff.ts — shared exponential-backoff-with-jitter for every reconnecting transport.
 * A fixed 3 s reconnect (a) hammers a down server and spams the SD-card log, and (b) synchronises every
 * box in the field onto the same `rotate.aprs2.net` cadence. This computes `min(cap, base·2ⁿ)·(0.5+rand)`
 * so the delay grows while an endpoint stays unreachable and the jitter desynchronises independent boxes.
 * `reset()` is called on a successful connect — a reachable endpoint starts over at the base interval.
 */
export interface BackoffOpts {
  baseMs?: number; // first delay (default 3000)
  capMs?: number; // ceiling for the exponential term (default 60000)
  rand?: () => number; // injectable RNG for deterministic tests (default Math.random)
}

export class Backoff {
  private n = 0;
  constructor(private o: BackoffOpts = {}) {}

  /** Next reconnect delay in ms: `min(cap, base·2ⁿ)·(0.5+rand)`. Escalates on each call until reset(). */
  next(): number {
    const base = this.o.baseMs ?? 3000;
    const cap = this.o.capMs ?? 60_000;
    const rand = this.o.rand ?? Math.random;
    const exp = Math.min(cap, base * 2 ** this.n);
    this.n++;
    return Math.floor(exp * (0.5 + rand()));
  }

  /** Reset the escalation — call on a successful connect (the endpoint is reachable again). */
  reset(): void {
    this.n = 0;
  }
}
