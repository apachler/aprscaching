// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * tombstones.ts — signed, PII-free delete propagation.
 *
 * When an instance erases data (a GDPR account delete, an explicit cache/find delete, or the sysop's removal
 * of a cache, a log or a bulletin — moderation.ts) it emits
 * a **tombstone**: a tiny signed record naming the *global id* of the removed record — never a
 * callsign or any other personal datum. Peers fetch the tombstone feed, verify the origin's
 * signature, and purge the matching mirrored record (`fedapply.ts:applyTombstone`). This is
 * what makes a delete converge across the network: the caches/finds feeds are append-only by cursor,
 * so they can't carry a removal — only a tombstone can.
 *
 *   GET /federation/tombstones?since=<seq>   tombstone records (cursor = the tombstones sequence, fed_seq)
 *
 * The feed signs at serve time, exactly like the caches/finds/keys feeds (so key rotation and
 * unsigned-instance behaviour stay consistent).
 *
 * A tombstone suppresses every version of its target, for good, with one exception: the sysop's removal
 * of a cache carries `upTo`, the cache's federation version at removal. A restored cache comes back at a
 * higher version (every update raises it), which peers mirror again; nothing at or below `upTo` ever
 * returns. An erasure (account, an owner's own delete, a released callsign) carries no `upTo`.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { serveFeed, type FeedServeDef } from "./federation.js";

type TombstoneKind = "account" | "find" | "cache" | "key" | "move" | "bulletin";
export interface TombstoneItem {
  kind: TombstoneKind;
  targetId: string;
  /** The highest version of the target it suppresses; absent for every version. */
  upTo?: number;
}

interface TombstoneRow {
  seq: number;
  fed_seq: number;
  kind: string;
  target_id: string;
  origin: string;
  ts: number;
  up_to: number | null;
}

/** The wire `data` payload — the signed, PII-free body peers verify and apply. */
function tombstoneData(r: { kind: string; target_id: string; origin: string; ts: number; up_to: number | null }) {
  return { kind: r.kind, targetId: r.target_id, origin: r.origin, ts: r.ts, ...(r.up_to != null && { upTo: r.up_to }) };
}

/**
 * Emit signed tombstones for already-removed federated records. `targetId` MUST be a namespaced
 * global id (e.g. `oe.aprscaching.net:find:42`), never a callsign/PII. Idempotent per (kind,target).
 */
export async function emitTombstones(env: Env, origin: string, items: TombstoneItem[]): Promise<number> {
  if (!items.length) return 0;
  const ts = nowS();
  const stmts = items.map((it) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO tombstones (id, kind, target_id, origin, ts, up_to) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), it.kind, it.targetId, origin, ts, it.upTo ?? null),
  );
  await env.DB.batch(stmts);
  return items.length;
}

/** Tombstone feed via the generalized envelope — cursor = the tombstones sequence (fed_seq), signed at serve time. */
export const TOMBSTONE_FEED: FeedServeDef<TombstoneRow> = {
  type: "tombstone",
  selectRows: async (env, since, limit) =>
    (
      await env.DB.prepare(
        "SELECT seq, fed_seq, kind, target_id, origin, ts, up_to FROM tombstones WHERE fed_seq > ? ORDER BY fed_seq LIMIT ?",
      )
        .bind(since, limit)
        .all<TombstoneRow>()
    ).results,
  recordOf: (r, instance) => ({ id: `${instance}:tombstone:${r.seq}`, cursor: r.fed_seq, data: tombstoneData(r) }),
};

export const handleFederationTombstones = (req: Request, env: Env): Promise<Response> =>
  serveFeed(req, env, TOMBSTONE_FEED);
