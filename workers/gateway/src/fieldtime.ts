// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The find time of a log. A log signed with the logger's device key carries the time the logger
 * submitted it (`signedAt`), which for a log queued offline is hours before the gateway receives it.
 * Verification looks for evidence around the find time — the logger's track in the window before it,
 * the phone's GPS fix within minutes of it — so a late-synced find is scored at its signed time, and gets
 * exactly the verification it would have had if sent at once.
 *
 * The signature proves who logged and when they say, but the logger controls their clock, so the
 * signed time is taken only within bounds; outside them the find time is the receive time, and the
 * reason is kept with the log. The time only moves the window the gateway searches; it never lifts a
 * tier by itself.
 */
import type { Env } from "./env.js";
import { POSITION_RETENTION_S } from "./retention.js";

/** How far ahead of the gateway's clock a signed time may be (phone clock skew). */
const FIELD_TIME_SKEW_S = 60;
/** The furthest back a signed time reaches: no evidence older than the position retention exists. */
const FIELD_TIME_MAX_LAG_S = POSITION_RETENTION_S;

/** Why a log's find time is its receive time rather than its signed field time. */
type FieldTimeRejection = "future" | "too_old" | "before_cache" | "before_key" | "unsigned";

interface FieldTime {
  /** The find time: the signed time when it passes the bounds, else the receive time. */
  foundAt: number;
  /** Set when the log was not timed by its signature; null for a signed time taken, or an unsigned live log. */
  rejected: FieldTimeRejection | null;
}

/**
 * The find time for a log received at `now`. `signed` is a verified signature's time and key (the caller
 * has checked the signature and that the key is registered to `loggerCall`); `offline` is the client's
 * statement that the log waited in its queue, which only labels an unsigned log.
 */
export async function fieldTime(
  env: Env,
  args: {
    now: number;
    loggerCall: string;
    cacheCreatedAt: number;
    signed: { at: number; key: string } | null;
    offline?: boolean;
  },
): Promise<FieldTime> {
  const { now, signed } = args;
  if (!signed) return { foundAt: now, rejected: args.offline ? "unsigned" : null };
  const reject = (rejected: FieldTimeRejection): FieldTime => ({ foundAt: now, rejected });
  if (signed.at > now + FIELD_TIME_SKEW_S) return reject("future");
  if (now - signed.at > FIELD_TIME_MAX_LAG_S) return reject("too_old");
  if (signed.at < args.cacheCreatedAt) return reject("before_cache");
  const key = await env.DB.prepare("SELECT created_at FROM callsign_keys WHERE callsign = ? AND public_key = ?")
    .bind(args.loggerCall.toUpperCase(), signed.key)
    .first<{ created_at: number }>();
  if (!key || signed.at < key.created_at) return reject("before_key");
  // a phone clock a few seconds ahead never puts a find after its own arrival
  return { foundAt: Math.min(signed.at, now), rejected: null };
}
