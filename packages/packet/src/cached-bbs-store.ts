// SPDX-License-Identifier: MIT
/**
 * cached-bbs-store.ts — a synchronous `MessageStore` over an async backend, so an inbound
 * connected-mode `BbsSession` (which reads the store one line at a time, synchronously) can be served from
 * the cloud gateway. The caller's mail snapshot is loaded ONCE at connect (`refresh()`), then every
 * list/read is served from that in-memory cache; `post()`/`kill()` update the cache optimistically and
 * fire the async writer in the background. Loading a *per-caller* snapshot (their personal mail + bulletins
 * + their sent) is also the access-control boundary — a connected user can only ever read what's in it.
 * Pure: the loader/writer are injected (gateway REST in the ingest; fakes in tests).
 */
import type { MessageStore, BbsMsgMeta, BbsMsgFull, BbsType } from "./bbs.js";

export interface CachedBbsBackend {
  /** Load the caller's snapshot (personal to/from them + current bulletins), with bodies. */
  load(call: string): Promise<BbsMsgFull[]>;
  /** Persist a new message; resolves with its real server id (best-effort). */
  post(m: {
    type: BbsType;
    from: string;
    to: string;
    subject: string | null;
    body: string;
    replyTo?: number | null;
  }): Promise<number>;
  /** Mark a personal message read (best-effort). */
  markRead?(id: number): Promise<void>;
  /** Kill a message the caller authored/received (best-effort). */
  kill?(id: number, call: string): Promise<void>;
}

const meta = (m: BbsMsgFull): BbsMsgMeta => ({
  id: m.id,
  type: m.type,
  from: m.from,
  to: m.to,
  subject: m.subject,
  postedAt: m.postedAt,
});

/** SR-PKT-13: how a cached store retries a failed backend write and how it surfaces a give-up. */
export interface CachedBbsStoreOpts {
  clock?: () => number; // wall clock for postedAt (default Date.now)
  maxRetries?: number; // backend write attempts before giving up (default 3)
  sleep?: (ms: number) => Promise<void>; // backoff delay (injected for tests; default real timer)
  /** Called when a post/kill ultimately fails after all retries — never swallow it silently. */
  onWriteError?: (op: "post" | "kill", err: unknown, id: number) => void;
}

export class CachedBbsStore implements MessageStore {
  private cache: BbsMsgFull[] = [];
  private tempId = -1; // synthetic ids for optimistic posts (reconciled on next refresh)
  private failedIds = new Set<number>(); // posts that never reached the backend (observability)
  private o: Required<Omit<CachedBbsStoreOpts, "onWriteError">> & Pick<CachedBbsStoreOpts, "onWriteError">;
  constructor(
    private call: string,
    private backend: CachedBbsBackend,
    opts: CachedBbsStoreOpts = {},
  ) {
    this.call = call.toUpperCase();
    this.o = {
      clock: opts.clock ?? Date.now,
      maxRetries: opts.maxRetries ?? 3,
      sleep: opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
      onWriteError: opts.onWriteError,
    };
  }

  /** Ids whose backend write failed after all retries (the optimistic cache row is flagged). */
  failedWrites(): number[] {
    return [...this.failedIds];
  }

  /** Run a best-effort backend write with bounded exponential backoff; report (don't swallow) a give-up. */
  private async withRetry<T>(op: "post" | "kill", id: number, fn: () => Promise<T>): Promise<T | undefined> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt < this.o.maxRetries) await this.o.sleep(250 * 2 ** attempt);
      }
    }
    this.failedIds.add(id);
    this.o.onWriteError?.(op, lastErr, id);
    return undefined;
  }

  /** Load (or reload) the caller's snapshot. Call once before greeting; the server awaits it. */
  async refresh(): Promise<void> {
    this.cache = await this.backend.load(this.call);
  }

  listNew(call: string): BbsMsgMeta[] {
    const cs = call.toUpperCase();
    return this.cache
      .filter((m) => (m.type === "B" && !m.readAt) || (m.type !== "B" && m.to === cs && !m.readAt))
      .map(meta);
  }
  listAll(): BbsMsgMeta[] {
    return this.cache.map(meta);
  }
  listBulletins(): BbsMsgMeta[] {
    return this.cache.filter((m) => m.type === "B").map(meta);
  }
  listMine(call: string): BbsMsgMeta[] {
    const cs = call.toUpperCase();
    return this.cache.filter((m) => m.from === cs || m.to === cs).map(meta);
  }

  read(id: number): BbsMsgFull | null {
    const m = this.cache.find((x) => x.id === id);
    if (!m) return null; // not in this caller's snapshot → not readable
    if (m.type !== "B" && !m.readAt) {
      m.readAt = 1;
      void this.backend.markRead?.(id);
    }
    return m;
  }

  post(m: {
    type: BbsType;
    from: string;
    to: string;
    subject: string | null;
    body: string;
    replyTo?: number | null;
  }): number {
    const id = this.tempId--;
    const full: BbsMsgFull = {
      id,
      type: m.type,
      from: m.from.toUpperCase(),
      to: m.to.toUpperCase(),
      subject: m.subject,
      postedAt: Math.floor(this.o.clock() / 1000), // real wall-clock, not the negative temp id
      body: m.body,
      replyTo: m.replyTo ?? null,
    };
    this.cache.push(full); // optimistic — visible immediately in this session
    // SR-PKT-13: retry the backend write with backoff; on final failure flag it + report, never a silent drop.
    void this.withRetry("post", id, () => this.backend.post(m)).then((realId) => {
      if (realId != null) full.id = realId;
    });
    return id;
  }

  kill(id: number, call: string): boolean {
    const cs = call.toUpperCase();
    const i = this.cache.findIndex((m) => m.id === id && (m.from === cs || m.to === cs));
    if (i < 0) return false; // not theirs (or not present) → refuse
    this.cache.splice(i, 1);
    if (this.backend.kill) void this.withRetry("kill", id, () => this.backend.kill!(id, cs));
    return true;
  }
}
