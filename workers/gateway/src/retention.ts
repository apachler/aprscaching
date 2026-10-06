// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How long the nightly job keeps the diagnostic and telemetry tables. These rings exist for the
 * Shack and for troubleshooting, never for verification, so they are short by default. An operator
 * may shorten or lengthen any of them with one setting, RETENTION: Instance settings → Privacy & retention,
 * or JSON in the environment, e.g. `RETENTION={"packetsHours":6,"sensorDays":90}`. An absent, non-numeric
 * or non-positive value keeps the default.
 */
import type { Env } from "./env.js";
import { FED_BBS_CATEGORY, RETENTION_FIELDS, type RetentionField } from "@aprscaching/shared";
import { jsonObjectSetting } from "./util/config.js";
import { setting } from "./siteconfig.js";

/** The retention of each table when RETENTION does not name it (RETENTION_FIELDS holds what each one is). */
export const RETENTION_DEFAULTS = Object.fromEntries(
  Object.entries(RETENTION_FIELDS).map(([k, f]) => [k, f.default]),
) as Record<RetentionField, number>;
type Retention = typeof RETENTION_DEFAULTS;

export function retentionFrom(env: Env): Retention {
  const set = jsonObjectSetting(setting(env, "RETENTION"));
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

/** Resolved reports and moderation log rows: long enough to show what was done about a repeat offender. */
const MODERATION_KEEP_DAYS = 730;
/** Finished and expired callsign claims and the holder-change trail: a year answers a dispute over a call. */
const CLAIM_KEEP_S = 365 * DAY_S;
/** Email sign-in and confirmation links, past use or expiry (the longest lives 24 hours). */
const EMAIL_TOKEN_USED_KEEP_S = DAY_S;
const EMAIL_TOKEN_KEEP_S = 2 * DAY_S;

/** Days resolved reports and moderation log rows are kept: `MODERATION_RETENTION_DAYS`, else the default. */
export function moderationKeepDays(env: Env): number {
  const n = Number(setting(env, "MODERATION_RETENTION_DAYS"));
  return Number.isInteger(n) && n > 0 ? n : MODERATION_KEEP_DAYS;
}

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
 * The nightly prune of the records kept about people: resolved reports and the moderation log, callsign claims
 * and the holder-change trail, and spent or expired email links. Open reports stay until the sysop settles them,
 * and the log rows of a suspension in force stay while it holds, since they say why.
 */
async function pruneRecords(env: Env, now: number): Promise<void> {
  const moderationBefore = now - moderationKeepDays(env) * DAY_S;
  await pruneBounded(
    env,
    "moderation_reports",
    "SELECT rowid FROM moderation_reports WHERE status = 'resolved' AND COALESCE(resolved_at, created_at) < ?",
    moderationBefore,
  );
  // A suspension in force keeps the rows saying why, also once its account is erased and the suspension lives on
  // the base call (the row's target is the base call the sysop suspended).
  await pruneBounded(
    env,
    "moderation_log",
    `SELECT rowid FROM moderation_log l WHERE l.at < ?
       AND NOT (l.action = 'suspend' AND (
         EXISTS (SELECT 1 FROM account_suspensions s WHERE s.account_id = l.target_account)
         OR EXISTS (SELECT 1 FROM callsign_suspensions c WHERE c.callsign = l.target_id AND (c.until IS NULL OR c.until > ?))))`,
    moderationBefore,
    now,
  );
  // a claim's on-air challenge is keyed `claim:<id>` and goes with it
  await pruneBounded(
    env,
    "callsign_challenges",
    `SELECT rowid FROM callsign_challenges WHERE account_id IN (
       SELECT 'claim:' || id FROM callsign_claims WHERE COALESCE(completed_at, created_at) < ?)`,
    now - CLAIM_KEEP_S,
  );
  await pruneBounded(
    env,
    "callsign_claims",
    "SELECT rowid FROM callsign_claims WHERE COALESCE(completed_at, created_at) < ?",
    now - CLAIM_KEEP_S,
  );
  await pruneBounded(env, "callsign_events", "SELECT rowid FROM callsign_events WHERE at < ?", now - CLAIM_KEEP_S);
  await pruneBounded(
    env,
    "email_tokens",
    "SELECT rowid FROM email_tokens WHERE (used = 1 AND created_at < ?) OR created_at < ?",
    now - EMAIL_TOKEN_USED_KEEP_S,
    now - EMAIL_TOKEN_KEEP_S,
  );
}

/**
 * The nightly prune of the operational queues and logs that only ever grow: the APRS-IS outbox, box commands,
 * BBS bulletins and the forward log, unseen watch alerts, stations long silent, and the records of
 * {@link pruneRecords}.
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
  // Personal mail and NTS traffic wait for their recipient and are deleted by them, not by age; a federation
  // batch (personal mail to ACSFED, read by no one) expires like a bulletin.
  await pruneBounded(
    env,
    "bbs_messages",
    `SELECT rowid FROM bbs_messages WHERE (type = 'B' OR to_call = '${FED_BBS_CATEGORY}') AND COALESCE(expires_at, posted_at + ?) <= ?`,
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
  // The record a suspension leaves on an erased account's calls lasts exactly as long as the suspension.
  await pruneBounded(
    env,
    "callsign_suspensions",
    "SELECT rowid FROM callsign_suspensions WHERE until IS NOT NULL AND until <= ?",
    now,
  );
  await pruneRecords(env, now);
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
