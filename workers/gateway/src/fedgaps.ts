// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedgaps.ts — the records of an origin this instance knows it does not hold whole, though its mark has moved past
 * them (fedtransit.ts). A mark that waited on such a record would hold every later record back with it, so the mark
 * moves on and the record is asked for again on its own, from every neighbour, until one fills it:
 *
 * - `unsettled`: a frame that did not settle here (signed ahead of this clock, one the database could not take, one
 *   kept nowhere, one that did not verify).
 * - `hops`: a record kept here past the hop limit, so this instance may not pass it on; a copy over fewer hops fills it.
 * - `upstream`: a record a neighbour said it lacks, on a page this instance took the neighbour's word for.
 * - `upstream-hops`: a record a neighbour keeps past the hop limit, so it may not pass it on.
 *
 * A neighbour fills a gap with the record, or by holding the origin past it and not lacking it (the record was
 * superseded, deleted or lies outside the region). Each neighbour is asked again after a backoff that doubles from 5
 * minutes to a day. A gap nobody fills within 7 days and 5 asks is given up: it counts as refused for good, and the
 * sysop sees it listed (Instance admin → Federation, `doctor`) until marked seen, for at most 90 days; a listed
 * record marked seen goes 30 days later. A hop-limit gap is no fault anyone can fix but by a shorter path, and at
 * the edge of the mesh every distant record is one: it holds no mark back, counts toward no cap, and goes silently
 * after 30 days.
 *
 * A tombstone gap is never given up. A missing tombstone is a deletion, often an erasure, that never reached this
 * instance: giving it up would keep the deleted record here for good. Such a gap is asked for again, once a day per
 * neighbour once its backoff is at the longest, until one fills it. A tombstone gap past the hop limit that this
 * instance holds itself (`hops`) still goes after 30 days, since the deletion applied here; one a neighbour holds
 * past the hop limit (`upstream-hops`) stays, since this instance still lacks it.
 */
import type { Env } from "./env.js";
import { json } from "./http.js";
import { nowS } from "./util/time.js";
import { requireSysop } from "./admin.js";

type GapReason = "unsettled" | "upstream" | "hops" | "upstream-hops";
const isHopGap = (r: GapReason) => r === "hops" || r === "upstream-hops";
/** SQL: the gaps that are not hop-limit gaps. */
const NOT_HOPS = "reason NOT IN ('hops', 'upstream-hops')";
/** Gaps of one origin and kind a neighbour's frames can open (unsettled, upstream); past it the mark waits again. */
const MAX_GAPS = 1000;
/** Hop-limit gaps kept of one origin and kind; past it they are not recorded at all. */
const MAX_HOP_GAPS = 10_000;
/** A gap nobody filled in this long, and after this many asks, is given up. */
const GAP_GIVE_UP_S = 7 * 86400;
const GAP_GIVE_UP_ASKS = 5;
/** Hop-limit gaps go after this long; given-up records seen this long ago leave the table. */
const QUIET_EXPIRY_S = 30 * 86400;
/** Given-up records the sysop never marked seen leave the table after this long. */
const UNSEEN_EXPIRY_S = 90 * 86400;
/** SQL: a gap whose record is a deletion this instance does not hold, which is never given up. */
const MISSING_DELETE = "(kind = 'tombstone' AND reason != 'hops')";
const RETRY_FIRST_S = 300;
const RETRY_MAX_S = 86400;

/**
 * Record a gap at `v`. False when the origin already has MAX_GAPS gaps a neighbour opened: the caller then keeps its
 * mark below `v` instead. A hop-limit gap never holds a mark back; past MAX_HOP_GAPS it is not recorded.
 */
export async function addGap(env: Env, origin: string, kind: string, v: number, reason: GapReason): Promise<boolean> {
  const n =
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND ${isHopGap(reason) ? "NOT " : ""}(${NOT_HOPS})`,
      )
        .bind(origin, kind)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (isHopGap(reason)) {
    if (n >= MAX_HOP_GAPS) return true;
  } else {
    if (n >= MAX_GAPS)
      return !!(await env.DB.prepare("SELECT 1 AS x FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND v = ?")
        .bind(origin, kind, v)
        .first());
  }
  await env.DB.prepare(
    `INSERT INTO fed_origin_gaps (origin, kind, v, reason, first_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(origin, kind, v) DO UPDATE SET reason = excluded.reason
     WHERE excluded.reason IN ('hops', 'upstream-hops')`,
  )
    .bind(origin, kind, v, reason, nowS())
    .run();
  return true;
}

/** The record at `v` is here now, or never will be from anyone: the gap is closed. */
export async function removeGap(env: Env, origin: string, kind: string, v: number): Promise<void> {
  await env.DB.prepare("DELETE FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND v = ?")
    .bind(origin, kind, v)
    .run();
}

/** Whether `origin` and `kind` already have MAX_GAPS gaps a neighbour opened, so a mark waits on the next one. */
export async function gapsFull(env: Env, origin: string, kind: string): Promise<boolean> {
  const n =
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND ${NOT_HOPS}`)
        .bind(origin, kind)
        .first<{ n: number }>()
    )?.n ?? 0;
  return n >= MAX_GAPS;
}

/** The gaps of `origin` and `kind` in `(after, upTo]`, hop-limit ones or the rest, lowest first, at most `limit`. */
export async function gapsBetween(
  env: Env,
  origin: string,
  kind: string,
  after: number,
  upTo: number,
  limit: number,
  hops = false,
): Promise<number[]> {
  return (
    await env.DB.prepare(
      `SELECT v FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND v > ? AND v <= ? AND ${hops ? "NOT " : ""}(${NOT_HOPS})
        ORDER BY v LIMIT ?`,
    )
      .bind(origin, kind, after, upTo, limit)
      .all<{ v: number }>()
  ).results.map((r) => r.v);
}

type Tries = Record<string, [number, number]>;
const parseTries = (s: string): Tries => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Tries) : {};
  } catch {
    return {};
  }
};

/**
 * The gaps of `origin` and `kind` due to be asked of `via` now, at most `limit`: the gaps a neighbour can fill before
 * those past the hop limit, which only a shorter path fills, then the longest overdue for `via` first. A gap `via`
 * was never asked about is due at once.
 */
export async function dueGaps(env: Env, origin: string, kind: string, via: string, limit: number): Promise<number[]> {
  return (
    await env.DB.prepare(
      `SELECT v FROM (
         SELECT v, reason, COALESCE((SELECT json_extract(value, '$[1]') FROM json_each(tries) WHERE key = ?), 0) AS due
           FROM fed_origin_gaps WHERE origin = ? AND kind = ?
       ) WHERE due <= ? ORDER BY reason IN ('hops', 'upstream-hops'), due, v LIMIT ?`,
    )
      .bind(via, origin, kind, nowS(), limit)
      .all<{ v: number }>()
  ).results.map((r) => r.v);
}

/** `via` did not fill the gap at `v`: ask it again after a backoff that doubles each time. */
export async function backOff(env: Env, origin: string, kind: string, v: number, via: string): Promise<void> {
  const row = await env.DB.prepare("SELECT tries FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND v = ?")
    .bind(origin, kind, v)
    .first<{ tries: string }>();
  if (!row) return;
  const tries = parseTries(row.tries);
  const n = (tries[via]?.[0] ?? 0) + 1;
  tries[via] = [n, nowS() + Math.min(RETRY_MAX_S, RETRY_FIRST_S * 2 ** (n - 1))];
  await env.DB.prepare(
    "UPDATE fed_origin_gaps SET tries = ?, attempts = attempts + 1 WHERE origin = ? AND kind = ? AND v = ?",
  )
    .bind(JSON.stringify(tries), origin, kind, v)
    .run();
}

/** Forget the gaps of `origin`, with what this instance held of it (fedtransit.ts resetMarks). */
export function forgetGapsStatement(env: Env, origin: string) {
  return env.DB.prepare("DELETE FROM fed_origin_gaps WHERE origin = ?").bind(origin);
}

/**
 * Give up the gaps nobody filled within GAP_GIVE_UP_S and GAP_GIVE_UP_ASKS asks, so they count as refused for good:
 * time alone is not enough, since a clock that jumps forward (a box without a real-time clock meeting NTP) would
 * give up every gap at once. A missing tombstone is never given up. Hop-limit gaps and seen given-up records past
 * QUIET_EXPIRY_S, and unseen ones past UNSEEN_EXPIRY_S, go without a word.
 * Returns how many gaps were given up.
 */
export async function giveUpGaps(env: Env): Promise<number> {
  const t = nowS();
  const due = `first_seen <= ? AND attempts >= ? AND ${NOT_HOPS} AND NOT ${MISSING_DELETE}`;
  const [, gone] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fed_gaps_given_up (origin, kind, v, reason, first_seen, given_up)
         SELECT origin, kind, v, reason, first_seen, ? FROM fed_origin_gaps WHERE ${due}
       ON CONFLICT(origin, kind, v) DO UPDATE SET given_up = excluded.given_up, seen_at = NULL`,
    ).bind(t, t - GAP_GIVE_UP_S, GAP_GIVE_UP_ASKS),
    env.DB.prepare(`DELETE FROM fed_origin_gaps WHERE ${due}`).bind(t - GAP_GIVE_UP_S, GAP_GIVE_UP_ASKS),
    env.DB.prepare(
      `DELETE FROM fed_origin_gaps WHERE NOT (${NOT_HOPS}) AND NOT ${MISSING_DELETE} AND first_seen <= ?`,
    ).bind(t - QUIET_EXPIRY_S),
    env.DB.prepare(
      "DELETE FROM fed_gaps_given_up WHERE (seen_at IS NOT NULL AND seen_at <= ?) OR (seen_at IS NULL AND given_up <= ?)",
    ).bind(t - QUIET_EXPIRY_S, t - UNSEEN_EXPIRY_S),
  ]);
  return gone?.meta.changes ?? 0;
}

/** The given-up records the sysop has not marked seen, newest first: how many, and the latest 200. */
export async function givenUpUnseen(env: Env) {
  const count =
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM fed_gaps_given_up WHERE seen_at IS NULL").first<{ n: number }>())
      ?.n ?? 0;
  const gaps = (
    await env.DB.prepare(
      `SELECT origin, kind, v, reason, first_seen AS firstSeen, given_up AS givenUp FROM fed_gaps_given_up
        WHERE seen_at IS NULL ORDER BY given_up DESC, origin, kind, v LIMIT 200`,
    ).all<{ origin: string; kind: string; v: number; reason: string; firstSeen: number; givenUp: number }>()
  ).results;
  return { count, gaps };
}

/** POST /federation/gaps/seen — the sysop has seen the given-up records: they leave the list. Sysop-only. */
export async function handleGapsSeen(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const r = await env.DB.prepare("UPDATE fed_gaps_given_up SET seen_at = ? WHERE seen_at IS NULL").bind(nowS()).run();
  return json({ ok: true, seen: r.meta.changes ?? 0 });
}
