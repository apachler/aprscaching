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
 * A find lifted this way is recorded with `corroborated_later_at`. Mirrors keep the tier they first
 * mirrored: the finds feed carries each log once.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { askPeers, corroboratorIgate, type CorroborationQuery, type PeerHit } from "./corroborate.js";
import { COARSEN } from "./corroborate_privacy.js";
import { DEFAULT_POLICY, plausiblePresence, type PositionRow } from "./verify.js";
import { awardFindBadges } from "./community.js";

/** When each attempt is due, after the find; their count is the attempt limit. */
export const RETRY_AFTER_S = [3600, 6 * 3600, 24 * 3600];
/** No attempt reaches further back than this. */
const RETRY_MAX_AGE_S = 72 * 3600;
/** Retries handled per run: the job runs every few minutes, so a backlog drains over a few runs. */
const RETRIES_PER_RUN = 20;

/** What a found log needs to be asked about again: the question and where the first round left it. */
export interface RetryPlan {
  query: CorroborationQuery;
  unreachable: string[];
  hits: PeerHit[];
}

/** Queue a later attempt for a found log. */
export async function scheduleRetry(env: Env, logId: number, loggedAt: number, plan: RetryPlan): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO corroboration_retries (log_id, query, peers, hits, logged_at, attempts, next_at) VALUES (?,?,?,?,?,0,?)",
  )
    .bind(
      logId,
      JSON.stringify(plan.query),
      JSON.stringify(plan.unreachable),
      JSON.stringify(plan.hits),
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
  logged_at: number;
  attempts: number;
  tier: string | null;
  logger_call: string | null;
  log_ts: number | null;
}

/** Run the attempts that are due. Returns how many were asked, lifted to Tier A, and dropped. */
export async function retryCorroborations(
  env: Env,
  now = nowS(),
): Promise<{ asked: number; upgraded: number; dropped: number }> {
  const out = { asked: 0, upgraded: 0, dropped: 0 };
  const rows = (
    await env.DB.prepare(
      `SELECT r.*, l.tier AS tier, l.logger_call AS logger_call, l.ts AS log_ts FROM corroboration_retries r
         LEFT JOIN cache_logs l ON l.id = r.log_id WHERE r.next_at <= ? ORDER BY r.next_at LIMIT ?`,
    )
      .bind(now, RETRIES_PER_RUN)
      .all<RetryRow>()
  ).results;
  const remove = (id: number) => env.DB.prepare("DELETE FROM corroboration_retries WHERE log_id = ?").bind(id).run();
  const drop = async (id: number) => {
    await remove(id);
    out.dropped++;
  };
  for (const r of rows) {
    // the log went, is settled, or the attempt would reach too far back
    if (r.tier == null || r.tier === "A" || !r.logger_call || r.log_ts == null || now - r.logged_at > RETRY_MAX_AGE_S) {
      await drop(r.log_id);
      continue;
    }
    let q: CorroborationQuery, peers: string[], prior: PeerHit[];
    try {
      q = JSON.parse(r.query) as CorroborationQuery;
      peers = JSON.parse(r.peers) as string[];
      prior = JSON.parse(r.hits) as PeerHit[];
    } catch {
      await drop(r.log_id);
      continue;
    }
    out.asked++;
    const res = await askPeers(env, q, { onlyUrls: peers, priorHits: prior });
    if (res.denied) {
      await drop(r.log_id); // a verified "no" settles it
      continue;
    }
    if (res.winner) {
      // the logger's own local track must allow the corroborated presence, as when the find was logged
      const lp = await env.DB.prepare(
        "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? AND source != 'service' ORDER BY ts DESC LIMIT 500",
      )
        .bind(r.logger_call, q.since, r.log_ts + 60)
        .all<PositionRow>();
      if (
        plausiblePresence(
          { lat: q.lat, lon: q.lon, ts: res.winner.ts },
          lp.results,
          DEFAULT_POLICY,
          COARSEN.timeBucketSec,
        )
      ) {
        const igate = corroboratorIgate({
          method: "aprs_rf_peer",
          peerIgate: res.winner.igateCall ?? null,
          loggerCall: r.logger_call,
        });
        const up = await env.DB.prepare(
          `UPDATE cache_logs SET tier = 'A', verified = 1, verify_method = 'aprs_rf_peer', corroborated_by = ?,
             distance_m = ?, matched_position_id = NULL, corroborator_igate = ?, corroborated_later_at = ?
           WHERE id = ? AND tier != 'A'`,
        )
          .bind(res.winner.instance, res.winner.distanceM, igate, now, r.log_id)
          .run();
        if ((up.meta?.changes ?? 0) > 0) {
          out.upgraded++;
          await awardFindBadges(env, r.logger_call);
          await remove(r.log_id);
          continue;
        }
      }
      await drop(r.log_id); // implausible for the logger's own track: settled below Tier A
      continue;
    }
    const attempts = r.attempts + 1;
    // nothing left to wait for once every peer answered, or the attempts ran out
    if (!res.unreachable.length || attempts >= RETRY_AFTER_S.length) {
      await drop(r.log_id);
      continue;
    }
    await env.DB.prepare(
      "UPDATE corroboration_retries SET attempts = ?, peers = ?, hits = ?, next_at = ? WHERE log_id = ?",
    )
      .bind(
        attempts,
        JSON.stringify(res.unreachable),
        JSON.stringify(res.hits),
        r.logged_at + RETRY_AFTER_S[attempts]!,
        r.log_id,
      )
      .run();
  }
  return out;
}
