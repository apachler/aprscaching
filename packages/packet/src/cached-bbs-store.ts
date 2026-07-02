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
  post(m: { type: BbsType; from: string; to: string; subject: string | null; body: string; replyTo?: number | null }): Promise<number>;
  /** Mark a personal message read (best-effort). */
  markRead?(id: number): Promise<void>;
  /** Kill a message the caller authored/received (best-effort). */
  kill?(id: number, call: string): Promise<void>;
}

const meta = (m: BbsMsgFull): BbsMsgMeta => ({ id: m.id, type: m.type, from: m.from, to: m.to, subject: m.subject, postedAt: m.postedAt });

export class CachedBbsStore implements MessageStore {
  private cache: BbsMsgFull[] = [];
  private tempId = -1;                                   // synthetic ids for optimistic posts (reconciled on next refresh)
  constructor(private call: string, private backend: CachedBbsBackend) { this.call = call.toUpperCase(); }

  /** Load (or reload) the caller's snapshot. Call once before greeting; the server awaits it. */
  async refresh(): Promise<void> { this.cache = await this.backend.load(this.call); }

  listNew(call: string): BbsMsgMeta[] {
    const cs = call.toUpperCase();
    return this.cache.filter((m) => (m.type === "B" && !m.readAt) || (m.type !== "B" && m.to === cs && !m.readAt)).map(meta);
  }
  listAll(): BbsMsgMeta[] { return this.cache.map(meta); }
  listBulletins(): BbsMsgMeta[] { return this.cache.filter((m) => m.type === "B").map(meta); }
  listMine(call: string): BbsMsgMeta[] {
    const cs = call.toUpperCase();
    return this.cache.filter((m) => m.from === cs || m.to === cs).map(meta);
  }

  read(id: number): BbsMsgFull | null {
    const m = this.cache.find((x) => x.id === id);
    if (!m) return null;                                 // not in this caller's snapshot → not readable
    if (m.type !== "B" && !m.readAt) { m.readAt = 1; void this.backend.markRead?.(id); }
    return m;
  }

  post(m: { type: BbsType; from: string; to: string; subject: string | null; body: string; replyTo?: number | null }): number {
    const id = this.tempId--;
    const full: BbsMsgFull = { id, type: m.type, from: m.from.toUpperCase(), to: m.to.toUpperCase(), subject: m.subject, postedAt: Math.floor(id), body: m.body, replyTo: m.replyTo ?? null };
    this.cache.push(full);                               // optimistic — visible immediately in this session
    void this.backend.post(m).then((realId) => { full.id = realId; }).catch(() => {});
    return id;
  }

  kill(id: number, call: string): boolean {
    const cs = call.toUpperCase();
    const i = this.cache.findIndex((m) => m.id === id && (m.from === cs || m.to === cs));
    if (i < 0) return false;                             // not theirs (or not present) → refuse
    this.cache.splice(i, 1);
    void this.backend.kill?.(id, cs).catch(() => {});
    return true;
  }
}
