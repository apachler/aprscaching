// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How long the nightly job keeps the diagnostic and telemetry tables. These rings exist for the
 * Shack and for troubleshooting, never for verification, so they are short by default. An operator
 * may shorten or lengthen any of them with one JSON setting, e.g.
 * `RETENTION={"packetsHours":6,"sensorDays":90}`; an absent, non-numeric or non-positive value keeps
 * the default.
 */
import type { Env } from "./env.js";
import { jsonObjectSetting } from "./util/config.js";

export const RETENTION_DEFAULTS = {
  /** The Shack raw-packet ring (packets_recent), in hours. */
  packetsHours: 24,
  /** The firehose message log and MeshCom group messages. */
  messagesDays: 7,
  /** Weather and telemetry readings. */
  sensorDays: 30,
  /** Per-port RX/TX counters. */
  portStatsDays: 7,
  /** Watch alerts the user has seen. */
  alertsDays: 30,
  /** NET/ROM node MHeard rows. */
  mheardDays: 7,
};
type Retention = typeof RETENTION_DEFAULTS;

export function retentionFrom(env: Env): Retention {
  const set = jsonObjectSetting(env.RETENTION);
  const out = { ...RETENTION_DEFAULTS };
  for (const k of Object.keys(out) as (keyof Retention)[]) {
    const v = set[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/**
 * How long the nightly prune keeps firehose and browser-bridge positions. Fixed rather than in RETENTION:
 * these are verification evidence, and a signed field time never reaches further back (fieldtime.ts).
 */
export const POSITION_RETENTION_S = 7 * 24 * 3600;

const DAY_S = 24 * 3600;

/**
 * How long a queued outbox item may wait for the ingest box. Older ones are never sent: a box that was
 * offline must not put stale weather beacons, radio answers and status announcements on APRS-IS. Nothing
 * retries through the outbox — a Mailbox message is queued afresh each time its station is heard.
 */
export const OUTBOX_QUEUED_TTL_S = 3600;
/** A queued box command the box has not collected within this window is expired, not handed out: an operator who
 *  keyed a beacon or a transmit an hour ago no longer expects it on the air when the box comes back. */
export const BOX_COMMAND_QUEUED_TTL_S = 3600;
/** Sent outbox items, kept to trace what the box published. */
const OUTBOX_SENT_KEEP_S = 7 * DAY_S;
/** Box commands in any state: the box log shows the latest few, and a week-old queued command is no longer wanted. */
const BOX_COMMAND_KEEP_S = 7 * DAY_S;
/** The FBB forward log, past which an entry stays only while its message is still offered for forwarding. */
const FORWARD_LOG_KEEP_S = 30 * DAY_S;
/** Watch alerts never seen: past this they are no longer news, and the email digest has carried them. */
const UNSEEN_ALERT_KEEP_S = 30 * DAY_S;
/** Stations silent this long leave the map, unless a living cache, a registered station or a node names them. */
const STATION_KEEP_S = 365 * DAY_S;

/** Rows one bounded delete removes, and the most batches one nightly run takes per table. */
const PRUNE_BATCH = 5000;
const PRUNE_BATCHES = 40;

/**
 * Delete the rows `select` names (a `SELECT rowid FROM … WHERE …`, without LIMIT) in bounded batches, so a
 * huge backlog never holds one long write transaction — on the synchronous Node runtime a single mega-DELETE
 * stalls every request until it finishes. The rowid-subquery LIMIT works on better-sqlite3 and bun:sqlite
 * alike. One run removes at most 200k rows per table; any remainder ages into the next night.
 */
export async function pruneBounded(env: Env, table: string, select: string, ...binds: unknown[]): Promise<void> {
  for (let i = 0; i < PRUNE_BATCHES; i++) {
    const r = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (${select} LIMIT ${PRUNE_BATCH})`)
      .bind(...binds)
      .run();
    if ((r.meta?.changes ?? 0) < PRUNE_BATCH) break;
  }
}

/**
 * The nightly prune of the operational queues and logs that only ever grow: the APRS-IS outbox, box commands,
 * BBS bulletins and the forward log, unseen watch alerts, and stations long silent.
 */
export async function pruneOperational(env: Env, now: number, bulletinLifetimeS: number): Promise<void> {
  await pruneBounded(
    env,
    "aprs_outbox",
    "SELECT rowid FROM aprs_outbox WHERE (status = 'queued' AND ts < ?) OR (status != 'queued' AND ts < ?)",
    now - OUTBOX_QUEUED_TTL_S,
    now - OUTBOX_SENT_KEEP_S,
  );
  await pruneBounded(
    env,
    "box_commands",
    "SELECT rowid FROM box_commands WHERE created_at < ?",
    now - BOX_COMMAND_KEEP_S,
  );
  // Bulletins expire; one stored without an expiry lives the default lifetime from when it was posted.
  // Personal mail and NTS traffic wait for their recipient and are deleted by them, not by age.
  await pruneBounded(
    env,
    "bbs_messages",
    "SELECT rowid FROM bbs_messages WHERE type = 'B' AND COALESCE(expires_at, posted_at + ?) <= ?",
    bulletinLifetimeS,
    now,
  );
  // A log entry is what keeps a message from being offered to that partner again, so it stays while its
  // message is still in the forwarding pool.
  await pruneBounded(
    env,
    "bbs_forward_log",
    `SELECT rowid FROM bbs_forward_log l WHERE l.forwarded_at < ? AND NOT EXISTS (
       SELECT 1 FROM bbs_messages m WHERE m.bid = l.bid AND (m.expires_at IS NULL OR m.expires_at > ?))`,
    now - FORWARD_LOG_KEEP_S,
    now,
  );
  await pruneBounded(
    env,
    "watch_alerts",
    "SELECT rowid FROM watch_alerts WHERE seen = 0 AND ts < ?",
    now - UNSEEN_ALERT_KEEP_S,
  );
  // A living cache sits at its station's last heard position, and a registered station or a MeshCom node is
  // drawn from its station row, so those rows stay however long they are silent.
  await pruneBounded(
    env,
    "stations",
    `SELECT rowid FROM stations s WHERE s.last_seen < ?
       AND NOT EXISTS (SELECT 1 FROM caches c WHERE c.type = 'aprs_living' AND UPPER(c.station_call) = s.callsign)
       AND NOT EXISTS (SELECT 1 FROM account_stations a WHERE UPPER(a.callsign) = s.callsign)
       AND NOT EXISTS (SELECT 1 FROM meshcom_nodes n WHERE n.callsign = s.callsign)`,
    now - STATION_KEEP_S,
  );
}
