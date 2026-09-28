// SPDX-License-Identifier: MIT
/**
 * Duplicate suppression across one MeshCom node's datagrams.
 *
 * A node reports the same frame more than once — heard over LoRa, then again from the MeshCom server —
 * and every copy carries the same `msg_id`. The first copy is new; a later copy is a duplicate, unless
 * its provenance is stronger (an RF sighting after a server copy, a direct hearing after a relayed one),
 * in which case it is an upgrade: the stronger provenance replaces the stored one and the caller
 * forwards the upgraded copy. Memory is bounded by `max` entries and by the time window.
 */
import type { MeshcomEvent, MeshcomProvenance } from "./normalize.js";

export type MeshcomDedupVerdict = "new" | "duplicate" | "upgrade";

export interface MeshcomDedupOpts {
  /** How long a frame id counts as seen (default ten minutes). */
  windowMs?: number;
  /** Most frame ids held at once (default 4096); the oldest go first. */
  max?: number;
}

/** Provenance strength: direct RF > relayed RF > internet or the node's own traffic. */
export function provenanceRank(p: MeshcomProvenance): number {
  return p.direct ? 2 : p.rf ? 1 : 0;
}

export class MeshcomDedup {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly seen = new Map<string, { at: number; rank: number }>();

  constructor(opts: MeshcomDedupOpts = {}) {
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.max = Math.max(1, opts.max ?? 4096);
  }

  get size(): number {
    return this.seen.size;
  }

  /** Classify an event. Events without a frame id (telemetry) are always new. */
  offer(e: MeshcomEvent, now: number): MeshcomDedupVerdict {
    const id = e.provenance.msgId;
    if (!id) return "new";
    const key = `${e.type}:${e.src}:${id}`;
    const rank = provenanceRank(e.provenance);
    const prior = this.seen.get(key);
    if (prior && now - prior.at < this.windowMs) {
      if (rank <= prior.rank) return "duplicate";
      this.store(key, prior.at, rank, now);
      return "upgrade";
    }
    this.store(key, now, rank, now);
    return "new";
  }

  private store(key: string, at: number, rank: number, now: number) {
    this.seen.delete(key); // re-insert so iteration order stays oldest-first
    this.seen.set(key, { at, rank });
    for (const [k, v] of this.seen) {
      if (this.seen.size <= this.max && now - v.at < this.windowMs) break;
      this.seen.delete(k);
    }
  }
}
