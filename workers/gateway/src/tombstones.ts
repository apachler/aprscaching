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
import { json } from "./app.js";
import { feedSigner } from "./federation.js";

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

export async function handleFederationTombstones(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const since = Math.max(0, Number(u.searchParams.get("since") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 200) || 200, 1), 1000);
  const instance = env.INSTANCE ?? u.host;
  const sign = await feedSigner(env);

  const rows = (await env.DB.prepare(
    "SELECT seq, kind, target_id, origin, ts FROM tombstones WHERE seq > ? ORDER BY seq LIMIT ?",
  ).bind(since, limit).all<TombstoneRow>()).results;

  let nextCursor = since;
  const items = [];
  for (const r of rows) {
    const id = `${instance}:tombstone:${r.seq}`;
    const data = tombstoneData(r);
    const rec: Record<string, unknown> = { type: "tombstone", id, cursor: r.seq, data };
    if (sign) { rec.sig = await sign("tombstone", id, data); rec.signer = instance; }
    items.push(rec);
    if (r.seq > nextCursor) nextCursor = r.seq;
  }
  return json({ instance, type: "tombstone", since, nextCursor, count: items.length, complete: items.length < limit, items });
}
