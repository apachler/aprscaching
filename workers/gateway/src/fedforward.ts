// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedforward.ts — the send half of federation over FBB, an experimental, delay-tolerant carrier. The
 * instance's own feed records are signed into fedwire frames (the same producer the HTTP sync surface uses),
 * packed into a text-safe `ACSFED` batch, and stored once as a local carrier message. The forwarding pool
 * offers it only to the partners the sysop marked for federation, as a personal message to `ACSFED` at that
 * partner's BBS: personal mail is delivered, never flooded, so a partner BBS does not pass it on to its own
 * partners. All of it is off unless `FED_BBS` is on. The batch's content-addressed BID rides
 * `bbs_messages.bid` (UNIQUE), so re-enqueueing an unchanged snapshot dedups here and a second copy dedups at
 * the receiver.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { instanceOf } from "./federation.js";
import { buildFedFrames } from "./fedsync.js";
import { BULLETIN_LIFETIME_SEC } from "./bbs.js";
import { encodeFedBbsBatch, FED_BBS_CATEGORY } from "@aprscaching/shared";
import { fedBbsOn, FED_BBS_OFF } from "./fedbbsgate.js";

/** Feed order inside a batch: tombstones FIRST, so a delete suppresses a stale record later in it. */
const ENQUEUE_TYPES = ["tombstone", "cache", "find", "key", "account-move", "bulletin"] as const;

/**
 * Pack signed frames into an `ACSFED` batch and store it as a local carrier message for the forwarding pool,
 * which offers it to the federation partners alone. Shared by the feed-snapshot enqueue, the relay's packet
 * leg and the relay's automatic answer. Stored as personal mail to `ACSFED`, so it never lists as a bulletin,
 * never rides the HTTP bulletin feed, and expires after the bulletin lifetime. The content BID hits
 * `bbs_messages.bid` (UNIQUE), so identical content never double-posts. Throws while `FED_BBS` is off.
 */
export async function enqueueAcsfedBulletin(
  env: Env,
  frames: Uint8Array[],
): Promise<{ bid: string; enqueued: number }> {
  if (!fedBbsOn(env)) throw new Error(FED_BBS_OFF);
  const bull = encodeFedBbsBatch(frames);
  const fromCall = (env.FED_OPERATOR ?? FED_BBS_CATEGORY).toUpperCase();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO bbs_messages (bid, type, from_call, to_call, subject, body, posted_at, expires_at, origin)
     VALUES (?, 'P', ?, ?, ?, ?, ?, ?, 'local')`,
  )
    .bind(bull.bid, fromCall, bull.category, bull.subject, bull.body, nowS(), nowS() + BULLETIN_LIFETIME_SEC)
    .run();
  return { bid: bull.bid, enqueued: res.meta.changes ? 1 : 0 };
}

/**
 * POST /federation/bbs/enqueue {types?, since?, limit?} — sysop or the operator secret; nothing on the
 * instance calls it on its own. Packs the local records of the requested feeds (default: all, tombstones
 * first) into ONE batch addressed to the reserved recipient. Refused while `FED_BBS` is off.
 */
export async function handleFedBbsEnqueue(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  if (!fedBbsOn(env)) return json({ error: FED_BBS_OFF }, { status: 409 });
  const b = (await req.json().catch(() => ({}))) as { types?: string[]; since?: number; limit?: number };
  const wanted = Array.isArray(b.types) && b.types.length ? new Set(b.types) : null;
  const types = ENQUEUE_TYPES.filter((t) => !wanted || wanted.has(t));
  const since = Math.max(0, Number(b.since) || 0);
  const limit = Math.min(Math.max(Number(b.limit) || 200, 1), 900);
  const instance = instanceOf(req, env);

  const frames: Uint8Array[] = [];
  const cursors: Record<string, number> = {};
  for (const t of types) {
    if (frames.length >= limit) break;
    const built = await buildFedFrames(env, instance, t, since, limit - frames.length);
    if (!built) return json({ error: "instance is unsigned — configure FED_PRIVATE_KEY" }, { status: 409 });
    frames.push(...built.frames);
    cursors[t] = built.nextCursor;
  }
  if (!frames.length) return json({ ok: true, frames: 0, enqueued: 0 });

  const bull = await enqueueAcsfedBulletin(env, frames);
  return json({
    ok: true,
    bid: bull.bid,
    frames: frames.length,
    enqueued: bull.enqueued,
    deduped: !bull.enqueued,
    cursors,
  });
}
