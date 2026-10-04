// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * deliver.ts — the queue between the transports and the gateway's ingest endpoint. Heard packets wait here
 * until a POST takes them; a gateway that is down, overloaded or rate-limiting keeps them queued (bounded,
 * oldest dropped first) and the next flush retries.
 *
 * A flush sends chunks of at most INGEST_BATCH_MAX packets, the most the gateway accepts in one batch, so a
 * backlog from a long outage drains over a few POSTs instead of being refused whole. A chunk the gateway
 * refuses as malformed or too large (400, 413, 422) would be refused again on every retry, so it is split
 * to deliver the rest and the packet it still refuses alone is dropped. Only one flush runs at a time.
 */
import { INGEST_BATCH_MAX, Packet } from "@aprscaching/shared";

/** Statuses that say the batch itself is unacceptable: retrying it unchanged cannot succeed. */
const REFUSED = new Set([400, 413, 422]);
/** Splits one flush may spend isolating refused packets; past it a refused chunk is dropped whole. */
const SPLIT_BUDGET = 16;

export interface DeliveryOpts {
  /** POST one batch to the gateway. A throw (network error, timeout) counts as "try again later". */
  post: (packets: Packet[]) => Promise<{ ok: boolean; status: number }>;
  /** Queue cap: past it the oldest packets are dropped, so an outage cannot exhaust memory. */
  maxQueue: number;
  /** Largest batch one POST carries (default INGEST_BATCH_MAX). */
  maxBatch?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

export class Delivery {
  private queue: Packet[] = [];
  private running: Promise<void> | null = null;
  private loggedAt = -Infinity;
  private lastError = "";
  /** Packets dropped because the queue was full or the gateway refused them, since start. */
  dropped = 0;

  constructor(private o: DeliveryOpts) {}

  /** Packets waiting for delivery. */
  get size(): number {
    return this.queue.length;
  }

  /** A copy of the queued packets, oldest first. */
  queued(): Packet[] {
    return this.queue.slice();
  }

  /**
   * Queue packets for the next flush. A packet the gateway's schema refuses (a field past its length
   * ceiling) is dropped here, so it never costs a refused POST and a split.
   */
  add(packets: Packet[]): void {
    const ok = packets.filter((p) => Packet.safeParse(p).success);
    if (ok.length < packets.length) {
      this.dropped += packets.length - ok.length;
      this.log(`dropped ${packets.length - ok.length} packet(s) with a field past its length ceiling`);
    }
    if (!ok.length) return;
    this.queue.push(...ok);
    this.cap();
  }

  /**
   * Deliver everything queued. A flush already in progress is joined instead of started again, so a slow
   * gateway never has two POSTs of the same packets in flight.
   */
  flush(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<void> {
    const max = Math.max(1, this.o.maxBatch ?? INGEST_BATCH_MAX);
    const budget = { splits: SPLIT_BUDGET };
    while (this.queue.length) {
      const undelivered = await this.send(this.queue.splice(0, max), budget);
      if (undelivered) {
        this.requeue(undelivered);
        return;
      }
    }
  }

  /**
   * Send one chunk, splitting it when the gateway refuses it. Returns the packets to retry later (the
   * gateway was unreachable), or null when every packet was delivered or dropped as refused.
   */
  private async send(chunk: Packet[], budget: { splits: number }): Promise<Packet[] | null> {
    let status: number;
    try {
      const res = await this.o.post(chunk);
      if (res.ok) return null;
      status = res.status;
    } catch (e) {
      this.lastError = (e as Error).message;
      return chunk;
    }
    if (!REFUSED.has(status)) {
      this.lastError = `HTTP ${status}`; // 401/403 (credential), 404, 408, 429, 5xx: the gateway may take it later
      return chunk;
    }
    if (chunk.length === 1 || budget.splits <= 0) {
      this.dropped += chunk.length;
      this.log(`gateway refused ${chunk.length} packet(s) (HTTP ${status}); dropped`);
      return null;
    }
    budget.splits--;
    const mid = Math.ceil(chunk.length / 2);
    const first = await this.send(chunk.slice(0, mid), budget);
    if (first) return first.concat(chunk.slice(mid));
    return this.send(chunk.slice(mid), budget);
  }

  /** Put undelivered packets back at the head of the queue, ahead of what arrived meanwhile. */
  private requeue(packets: Packet[]): void {
    this.queue.unshift(...packets);
    this.cap();
    const now = (this.o.now ?? Date.now)();
    if (now - this.loggedAt > 30_000) {
      this.loggedAt = now; // at most one line every 30 s, so a dead gateway cannot flood the SD card
      this.log(`gateway unreachable (${this.lastError}); ${this.queue.length}/${this.o.maxQueue} packet(s) queued`);
    }
  }

  private cap(): void {
    const over = this.queue.length - this.o.maxQueue;
    if (over <= 0) return;
    this.queue.splice(0, over);
    this.dropped += over;
  }

  private log(msg: string): void {
    (this.o.log ?? ((m) => console.error(`[forward] ${m}`)))(msg);
  }
}
