// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * tombstones.ts — F4/T1.3 + ADR-5: signed, PII-free delete propagation.
 *
 * When an instance erases data (a GDPR account delete, later an explicit cache/find delete) it emits
 * a **tombstone**: a tiny signed record naming the *global id* of the removed record — never a
 * callsign or any other personal datum. Peers fetch the tombstone feed, verify the origin's
 * signature, and purge the matching mirrored record (`federation_sync.ts:syncTombstones`). This is
 * what makes a delete converge across the network: the caches/finds feeds are append-only by cursor,
 * so they can't carry a removal — only a tombstone can.
 *
 *   GET /federation/tombstones?since=<seq>   signed tombstone records (cursor = monotonic seq)
 *
 * The feed signs at serve time, exactly like the caches/finds/keys feeds (so key rotation and
 * unsigned-instance behaviour stay consistent).
 */
import type { Env } from "./env.js";
import { serveFeed, type FeedServeDef } from "./federation.js";

const now = () => Math.floor(Date.now() / 1000);

export type TombstoneKind = "account" | "find" | "cache";
export interface TombstoneItem { kind: TombstoneKind; targetId: string }

interface TombstoneRow { seq: number; kind: string; target_id: string; origin: string; ts: number }

/** The wire `data` payload — the signed, PII-free body peers verify and apply. */
function tombstoneData(r: { kind: string; target_id: string; origin: string; ts: number }) {
  return { kind: r.kind, targetId: r.target_id, origin: r.origin, ts: r.ts };
}

/**
 * Emit signed tombstones for already-removed federated records. `targetId` MUST be a namespaced
 * global id (e.g. `oe.aprscaching.net:find:42`), never a callsign/PII. Idempotent per (kind,target).
 */
export async function emitTombstones(env: Env, origin: string, items: TombstoneItem[]): Promise<number> {
  if (!items.length) return 0;
  const ts = now();
  const stmts = items.map((it) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO tombstones (id, kind, target_id, origin, ts) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), it.kind, it.targetId, origin, ts),
  );
  await env.DB.batch(stmts);
  return items.length;
}

/** Tombstone feed via the generalized envelope (T2.2) — cursor = monotonic seq, signed at serve time. */
export const TOMBSTONE_FEED: FeedServeDef<TombstoneRow> = {
  type: "tombstone",
  selectRows: async (env, since, limit) => (await env.DB.prepare(
    "SELECT seq, kind, target_id, origin, ts FROM tombstones WHERE seq > ? ORDER BY seq LIMIT ?",
  ).bind(since, limit).all<TombstoneRow>()).results,
  recordOf: (r, instance) => ({ id: `${instance}:tombstone:${r.seq}`, cursor: r.seq, data: tombstoneData(r) }),
};

export const handleFederationTombstones = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, TOMBSTONE_FEED);
