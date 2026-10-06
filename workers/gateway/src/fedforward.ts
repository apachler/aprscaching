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
import { json } from "./http.js";
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

/** Where one feed resumes: its cursor and, in a feed whose cursor can repeat, the id of the last row sent. */
interface FeedCursor {
  cursor: number;
  id?: number;
}

/**
 * Read `since` for one feed: a number starts every feed there, and the previous answer's `cursors` object
 * resumes each feed where it stopped. The feeds count in different units (a bulletin's cursor is a time in
 * seconds, the other feeds' a `fed_seq` value), so one shared number cannot resume them all.
 */
function sinceFor(since: unknown, type: string): FeedCursor {
  if (typeof since === "number" || typeof since === "string") return { cursor: Math.max(0, Number(since) || 0) };
  if (!since || typeof since !== "object") return { cursor: 0 };
  const v = (since as Record<string, unknown>)[type];
  if (typeof v === "number") return { cursor: Math.max(0, v) };
  if (!v || typeof v !== "object") return { cursor: 0 };
  const { cursor, id } = v as { cursor?: unknown; id?: unknown };
  return { cursor: Math.max(0, Number(cursor) || 0), ...(Number.isSafeInteger(id) && { id: id as number }) };
}

/**
 * POST /federation/bbs/enqueue {types?, since?, limit?} — sysop or the operator secret; nothing on the
 * instance calls it on its own. Packs the local records of the requested feeds (default: all, tombstones
 * first) into ONE batch addressed to the reserved recipient. The answer's `cursors` holds the position of
 * every requested feed, the ones the limit left untouched included, so passing it back as `since` resumes
 * each feed where it stopped. Refused while `FED_BBS` is off.
 */
export async function handleFedBbsEnqueue(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  if (!fedBbsOn(env)) return json({ error: FED_BBS_OFF }, { status: 409 });
  const b = (await req.json().catch(() => ({}))) as { types?: string[]; since?: unknown; limit?: number };
  const wanted = Array.isArray(b.types) && b.types.length ? new Set(b.types) : null;
  const types = ENQUEUE_TYPES.filter((t) => !wanted || wanted.has(t));
  const limit = Math.min(Math.max(Number(b.limit) || 200, 1), 900);
  const instance = instanceOf(req, env);

  const frames: Uint8Array[] = [];
  const cursors: Record<string, FeedCursor> = {};
  for (const t of types) {
    const from = sinceFor(b.since, t);
    cursors[t] = from;
    if (frames.length >= limit) continue;
    const built = await buildFedFrames(env, instance, t, from.cursor, limit - frames.length, from.id);
    if (!built) return json({ error: "instance is unsigned — configure FED_PRIVATE_KEY" }, { status: 409 });
    frames.push(...built.frames);
    cursors[t] = { cursor: built.nextCursor, ...(built.nextId !== undefined && { id: built.nextId }) };
  }
  if (!frames.length) return json({ ok: true, frames: 0, enqueued: 0, cursors });

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
