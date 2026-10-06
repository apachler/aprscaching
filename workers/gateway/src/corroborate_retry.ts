// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * corroborate_retry.ts — a bounded later attempt at cross-instance corroboration.
 *
 * A found log that missed Tier A only because trusted peers could not be reached (a timeout, a failed
 * connection, a rate limit or a server error) is asked again: the identical question, to those peers
 * only, at most three times — one, six and 24 hours after the find — and never past 72 hours, well
 * inside the seven days an answerer looks back. Evidence already in hand carries over, but counts only
 * while its peer is still trusted. The quorum, the independence exclusions, the answer checks and the
 * logger's own-track plausibility check are the same as when the find was logged. It stops for good as
 * soon as a trusted peer answers with a verified "no", the find reaches Tier A, or every peer has
 * answered.
 *
 * A trusted peer nobody can dial is asked through a hub's relay (corroborate.ts `askPeers`), and its
 * answer arrives once the spoke collects the question. {@link collectRelayedCorroborations} reads those
 * answers on the relay timer (`FED_RELAY_POLL_MS`, 15 s), so a find confirmed by a firewalled spoke
 * lifts within seconds of the spoke's poll; a question its hub dropped, or that waited an hour, goes back
 * to the peers the next attempt asks.
 *
 * A find lifted this way is recorded with `corroborated_later_at`. Mirrors keep the tier they first
 * mirrored: the finds feed carries each log once.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import {
  askPeers,
  collectRelayed,
  corroboratorIgate,
  type CorroborationQuery,
  type Evidence,
  type PeerHit,
  type RelayedAsk,
} from "./corroborate.js";
import { COARSEN } from "./corroborate_privacy.js";
import { DEFAULT_POLICY, plausiblePresence, type PositionRow } from "./verify.js";
import { awardFindBadges } from "./community.js";

/** When each attempt is due, after the find; their count is the attempt limit. */
export const RETRY_AFTER_S = [3600, 6 * 3600, 24 * 3600];
/** No attempt reaches further back than this. */
const RETRY_MAX_AGE_S = 72 * 3600;
/** Retries handled per run: the job runs every few minutes, so a backlog drains over a few runs. */
const RETRIES_PER_RUN = 20;
/** While only relayed questions wait, the next attempt looks again this much later. */
const RELAY_WAIT_RECHECK_S = 600;

/** What a found log needs to be asked about again: the question and where the first round left it. */
export interface RetryPlan {
  query: CorroborationQuery;
  unreachable: string[];
  hits: PeerHit[];
  /** Questions waiting in a hub's relay queue for peers nobody can dial. */
  relayed: RelayedAsk[];
}

/** Queue a later attempt for a found log. */
export async function scheduleRetry(env: Env, logId: number, loggedAt: number, plan: RetryPlan): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO corroboration_retries (log_id, query, peers, hits, relayed, logged_at, attempts, next_at) VALUES (?,?,?,?,?,?,0,?)",
  )
    .bind(
      logId,
      JSON.stringify(plan.query),
      JSON.stringify(plan.unreachable),
      JSON.stringify(plan.hits),
      JSON.stringify(plan.relayed),
      loggedAt,
      loggedAt + RETRY_AFTER_S[0]!,
    )
    .run();
}

interface RetryRow {
  log_id: number;
  query: string;
  peers: string;
  hits: string;
  relayed: string;
  logged_at: number;
  attempts: number;
  next_at: number;
  tier: string | null;
  logger_call: string | null;
  log_ts: number | null;
}

const ROW_SQL = `SELECT r.*, l.tier AS tier, l.logger_call AS logger_call, l.ts AS log_ts FROM corroboration_retries r
  LEFT JOIN cache_logs l ON l.id = r.log_id`;

/** The log went, is settled, or an attempt would reach too far back. */
const settled = (r: RetryRow, now: number): boolean =>
  r.tier == null || r.tier === "A" || !r.logger_call || r.log_ts == null || now - r.logged_at > RETRY_MAX_AGE_S;

function parseRow(
  r: RetryRow,
): { q: CorroborationQuery; peers: string[]; prior: PeerHit[]; relayed: RelayedAsk[] } | null {
  try {
    return {
      q: JSON.parse(r.query) as CorroborationQuery,
      peers: JSON.parse(r.peers) as string[],
      prior: JSON.parse(r.hits) as PeerHit[],
      relayed: JSON.parse(r.relayed || "[]") as RelayedAsk[],
    };
  } catch {
    return null;
  }
}

const removeRow = (env: Env, id: number) =>
  env.DB.prepare("DELETE FROM corroboration_retries WHERE log_id = ?").bind(id).run();

/**
 * Lift a found log to Tier A on a later quorum, when the logger's own local track allows the corroborated
 * presence, as when the find was logged. True when the log was lifted.
 */
async function liftLater(
  env: Env,
  r: RetryRow,
  q: CorroborationQuery,
  winner: Evidence,
  now: number,
): Promise<boolean> {
  const lp = await env.DB.prepare(
    "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? AND source != 'service' ORDER BY ts DESC LIMIT 500",
  )
    .bind(r.logger_call, q.since, (r.log_ts ?? 0) + 60)
    .all<PositionRow>();
  if (!plausiblePresence({ lat: q.lat, lon: q.lon, ts: winner.ts }, lp.results, DEFAULT_POLICY, COARSEN.timeBucketSec))
    return false;
  const igate = corroboratorIgate({
    method: "aprs_rf_peer",
    peerIgate: winner.igateCall ?? null,
    loggerCall: r.logger_call as string,
  });
  const up = await env.DB.prepare(
    `UPDATE cache_logs SET tier = 'A', verified = 1, verify_method = 'aprs_rf_peer', corroborated_by = ?,
       distance_m = ?, matched_position_id = NULL, corroborator_igate = ?, corroborated_later_at = ?
     WHERE id = ? AND tier != 'A'`,
  )
    .bind(winner.instance, winner.distanceM, igate, now, r.log_id)
    .run();
  if ((up.meta?.changes ?? 0) === 0) return false;
  await awardFindBadges(env, r.logger_call as string);
  return true;
}

/** Run the attempts that are due. Returns how many were asked, lifted to Tier A, and dropped. */
export async function retryCorroborations(
  env: Env,
  now = nowS(),
): Promise<{ asked: number; upgraded: number; dropped: number }> {
  const out = { asked: 0, upgraded: 0, dropped: 0 };
  const rows = (
    await env.DB.prepare(`${ROW_SQL} WHERE r.next_at <= ? ORDER BY r.next_at LIMIT ?`)
      .bind(now, RETRIES_PER_RUN)
      .all<RetryRow>()
  ).results;
  const drop = async (id: number) => {
    await removeRow(env, id);
    out.dropped++;
  };
  for (const r of rows) {
    const p = settled(r, now) ? null : parseRow(r);
    if (!p) {
      await drop(r.log_id);
      continue;
    }
    if (!p.peers.length) {
      // only relayed questions wait: their answers are collected as they come, so look again later
      if (p.relayed.length)
        await env.DB.prepare("UPDATE corroboration_retries SET next_at = ? WHERE log_id = ?")
          .bind(now + RELAY_WAIT_RECHECK_S, r.log_id)
          .run();
      else await drop(r.log_id);
      continue;
    }
    out.asked++;
    const res = await askPeers(env, p.q, { onlyUrls: p.peers, priorHits: p.prior });
    if (res.denied) {
      await drop(r.log_id); // a verified "no" settles it
      continue;
    }
    if (res.winner) {
      if (await liftLater(env, r, p.q, res.winner, now)) {
        out.upgraded++;
        await removeRow(env, r.log_id);
      } else await drop(r.log_id); // implausible for the logger's own track: settled below Tier A
      continue;
    }
    const attempts = r.attempts + 1;
    const relayed = [...p.relayed.filter((a) => !res.relayed.some((b) => b.url === a.url)), ...res.relayed];
    // nothing left to wait for once every peer answered, or the attempts ran out
    if ((!res.unreachable.length || attempts >= RETRY_AFTER_S.length) && !relayed.length) {
      await drop(r.log_id);
      continue;
    }
    const nextAt =
      res.unreachable.length && attempts < RETRY_AFTER_S.length
        ? r.logged_at + RETRY_AFTER_S[attempts]!
        : now + RELAY_WAIT_RECHECK_S;
    await env.DB.prepare(
      "UPDATE corroboration_retries SET attempts = ?, peers = ?, hits = ?, relayed = ?, next_at = ? WHERE log_id = ?",
    )
      .bind(
        attempts,
        JSON.stringify(attempts < RETRY_AFTER_S.length ? res.unreachable : []),
        JSON.stringify(res.hits),
        JSON.stringify(relayed),
        nextAt,
        r.log_id,
      )
      .run();
  }
  return out;
}

/**
 * Read the answers to relayed questions (corroborate.ts `collectRelayed`) and settle each find they
 * decide: lifted to Tier A on quorum, dropped on a trusted peer's verified "no", and kept while questions
 * still wait. A question that expired goes back to the peers the next attempt asks.
 */
export async function collectRelayedCorroborations(
  env: Env,
  now = nowS(),
): Promise<{ collected: number; upgraded: number; dropped: number }> {
  const out = { collected: 0, upgraded: 0, dropped: 0 };
  const rows = (
    await env.DB.prepare(`${ROW_SQL} WHERE r.relayed != '[]' ORDER BY r.logged_at LIMIT ?`)
      .bind(RETRIES_PER_RUN)
      .all<RetryRow>()
  ).results;
  for (const r of rows) {
    const p = settled(r, now) ? null : parseRow(r);
    if (!p) {
      await removeRow(env, r.log_id);
      out.dropped++;
      continue;
    }
    out.collected++;
    const got = await collectRelayed(env, p.q, p.relayed, p.prior, now);
    if (got.denied) {
      await removeRow(env, r.log_id); // a verified "no" settles it
      out.dropped++;
      continue;
    }
    if (got.winner) {
      if (await liftLater(env, r, p.q, got.winner, now)) out.upgraded++;
      else out.dropped++;
      await removeRow(env, r.log_id);
      continue;
    }
    const peers = [...new Set([...p.peers, ...(r.attempts < RETRY_AFTER_S.length ? got.expired : [])])];
    if (!got.waiting.length && !peers.length) {
      await removeRow(env, r.log_id);
      out.dropped++;
      continue;
    }
    // an expired question is asked again at the next attempt; with none left on the schedule, soon
    const nextAt = got.expired.length && !p.peers.length ? Math.min(r.next_at, now + RELAY_WAIT_RECHECK_S) : r.next_at;
    await env.DB.prepare(
      "UPDATE corroboration_retries SET peers = ?, hits = ?, relayed = ?, next_at = ? WHERE log_id = ?",
    )
      .bind(JSON.stringify(peers), JSON.stringify(got.hits), JSON.stringify(got.waiting), nextAt, r.log_id)
      .run();
  }
  return out;
}
