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
 *
 * A neighbour fills a gap with the record, or by holding the origin past it and not lacking it (the record was
 * superseded, deleted or lies outside the region). Each neighbour is asked again after a backoff that doubles from 5
 * minutes to a day. A gap nobody fills in 7 days is given up: it counts as refused for good, and the sysop sees it
 * listed (Instance admin → Federation, `doctor`) until marked seen.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { nowS } from "./util/time.js";
import { requireSysop } from "./admin.js";

export type GapReason = "unsettled" | "hops" | "upstream";
/** Gaps of one origin and kind a neighbour's frames can open (unsettled, upstream); past it the mark waits again. */
const MAX_GAPS = 1000;
/** A gap nobody filled in this long is given up. */
const GAP_GIVE_UP_S = 7 * 86400;
const RETRY_FIRST_S = 300;
const RETRY_MAX_S = 86400;

/**
 * Record a gap at `v`. False when the origin already has MAX_GAPS gaps a neighbour opened: the caller then keeps its
 * mark below `v` instead.
 */
export async function addGap(env: Env, origin: string, kind: string, v: number, reason: GapReason): Promise<boolean> {
  if (reason !== "hops") {
    const n =
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND reason != 'hops'",
        )
          .bind(origin, kind)
          .first<{ n: number }>()
      )?.n ?? 0;
    if (n >= MAX_GAPS)
      return !!(await env.DB.prepare("SELECT 1 AS x FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND v = ?")
        .bind(origin, kind, v)
        .first());
  }
  await env.DB.prepare(
    `INSERT INTO fed_origin_gaps (origin, kind, v, reason, first_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(origin, kind, v) DO NOTHING`,
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

/** The gaps of `origin` and `kind` in `(after, upTo]`, lowest first, at most `limit`. */
export async function gapsBetween(
  env: Env,
  origin: string,
  kind: string,
  after: number,
  upTo: number,
  limit: number,
): Promise<number[]> {
  return (
    await env.DB.prepare(
      "SELECT v FROM fed_origin_gaps WHERE origin = ? AND kind = ? AND v > ? AND v <= ? ORDER BY v LIMIT ?",
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

/** The gaps of `origin` and `kind` due to be asked of `via` now, lowest first, at most `limit`. */
export async function dueGaps(env: Env, origin: string, kind: string, via: string, limit: number): Promise<number[]> {
  const t = nowS();
  const rows = (
    await env.DB.prepare("SELECT v, tries FROM fed_origin_gaps WHERE origin = ? AND kind = ? ORDER BY v LIMIT 500")
      .bind(origin, kind)
      .all<{ v: number; tries: string }>()
  ).results;
  return rows
    .filter((r) => (parseTries(r.tries)[via]?.[1] ?? 0) <= t)
    .slice(0, limit)
    .map((r) => r.v);
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
  await env.DB.prepare("UPDATE fed_origin_gaps SET tries = ? WHERE origin = ? AND kind = ? AND v = ?")
    .bind(JSON.stringify(tries), origin, kind, v)
    .run();
}

/** Forget the gaps of `origin`, with what this instance held of it (fedtransit.ts resetMarks). */
export function forgetGapsStatement(env: Env, origin: string) {
  return env.DB.prepare("DELETE FROM fed_origin_gaps WHERE origin = ?").bind(origin);
}

/** Give up the gaps nobody filled in GAP_GIVE_UP_S, so they count as refused for good. Returns how many. */
export async function giveUpGaps(env: Env): Promise<number> {
  const t = nowS();
  const cut = t - GAP_GIVE_UP_S;
  const [, gone] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fed_gaps_given_up (origin, kind, v, reason, first_seen, given_up)
         SELECT origin, kind, v, reason, first_seen, ? FROM fed_origin_gaps WHERE first_seen <= ?
       ON CONFLICT(origin, kind, v) DO UPDATE SET given_up = excluded.given_up, seen_at = NULL`,
    ).bind(t, cut),
    env.DB.prepare("DELETE FROM fed_origin_gaps WHERE first_seen <= ?").bind(cut),
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
