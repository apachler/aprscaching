// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedforward.ts — the send half of the FBB store-and-forward federation carrier. The instance's own
 * feed records are signed into fedwire frames (the same producer the HTTP sync surface uses), packed
 * into a text-safe `ACSFED` bulletin, and enqueued as a local BBS bulletin — from there the existing
 * forwarding rules, pool, and partner scheduler carry it across the mesh like any other bulletin.
 * The bulletin's content-addressed BID rides `bbs_messages.bid` (UNIQUE), so re-enqueueing an
 * unchanged snapshot dedups here, and every relay hop dedups the flood the same way.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { instanceOf } from "./federation.js";
import { buildFedFrames } from "./fedsync.js";
import { encodeFedBbsBatch, FED_BBS_CATEGORY } from "@aprsweb/shared";

const now = () => Math.floor(Date.now() / 1000);

/** Feed order inside a batch: tombstones FIRST, so a delete suppresses a stale record later in it. */
const ENQUEUE_TYPES = ["tombstone", "cache", "find", "key", "account-move", "bulletin"] as const;

/**
 * POST /federation/bbs/enqueue {types?, since?, limit?} — sysop or the operator's ingest box (the
 * forwarding scheduler triggers it on its own cadence). Packs the local records of the requested
 * feeds (default: all, tombstones first) into ONE bulletin addressed to the reserved category.
 */
export async function handleFedBbsEnqueue(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowIngest: true });
  if (denied) return denied;
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

  const bull = encodeFedBbsBatch(frames);
  const fromCall = (env.FED_APRS_CALL ?? env.FED_OPERATOR ?? FED_BBS_CATEGORY).toUpperCase();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO bbs_messages (bid, type, from_call, to_call, subject, body, posted_at, origin)
     VALUES (?, 'B', ?, ?, ?, ?, ?, 'local')`,
  )
    .bind(bull.bid, fromCall, bull.category, bull.subject, bull.body, now())
    .run();
  return json({
    ok: true,
    bid: bull.bid,
    frames: frames.length,
    enqueued: res.meta.changes ? 1 : 0,
    deduped: !res.meta.changes,
    cursors,
  });
}
