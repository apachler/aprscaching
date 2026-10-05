// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * findrules.ts — the game's rules for who may log what, the same for a log from the app, from the offline queue
 * and over the radio:
 *
 *  - a find counts once per person: any SSID of the logger's base call, or any callsign on their account, holds it;
 *  - an archived or disabled cache takes no find and no did-not-find (a note or an owner's maintenance log stays
 *    possible, so the owner can say why and bring it back);
 *  - an owner does not find their own cache, and only the owner posts maintenance, enabled and disabled logs;
 *  - a staged cache is found at its last stage: the finder has unlocked it, and the find is verified at its
 *    position ({@link findPoint}).
 *
 * Finds are stored under the exact call a player logged with (OE8APR-7); everything that counts them for a person
 * (the leaderboard, profiles, badges, who may rate) groups by the base call, through {@link baseSql}.
 */
import type { Env } from "./env.js";
import { baseHolder } from "./auth.js";
import { baseCall } from "@aprscaching/aprs";
import { callSuspended, SUSPENDED_TEXT } from "./moderation.js";

/** SQL for the base call of a callsign column: the part before the SSID's dash, as `baseCall` does. */
export const baseSql = (col: string): string =>
  `(CASE WHEN instr(${col}, '-') > 0 THEN substr(${col}, 1, instr(${col}, '-') - 1) ELSE ${col} END)`;

/**
 * Has this person already logged a found for the cache? Any SSID of the logger's base call, or of any callsign on
 * their account, holds it. Without an account id, the account holding the base call is used.
 */
export async function alreadyFound(
  env: Env,
  cacheId: number,
  loggerCall: string,
  accountId: string | null,
): Promise<string | null> {
  const base = baseCall(loggerCall);
  const acct = accountId ?? (await baseHolder(env, base));
  const r = await env.DB.prepare(
    `SELECT l.logger_call AS call FROM cache_logs l WHERE l.cache_id = ? AND l.log_type = 'found' AND (
       l.logger_call = ? OR l.logger_call LIKE ? || '-%'
       OR EXISTS (SELECT 1 FROM account_callsigns ac WHERE ac.account_id = ?
                  AND (l.logger_call = ac.callsign OR l.logger_call LIKE ac.callsign || '-%'))
     ) LIMIT 1`,
  )
    .bind(cacheId, base, base, acct)
    .first<{ call: string }>();
  return r?.call ?? null;
}

/** Has this person unlocked the stage? An unlock by any SSID of the base call, or any call on the account, counts. */
async function hasUnlocked(
  env: Env,
  cacheId: number,
  stageNo: number,
  loggerCall: string,
  accountId: string | null,
): Promise<boolean> {
  const base = baseCall(loggerCall);
  const acct = accountId ?? (await baseHolder(env, base));
  const r = await env.DB.prepare(
    `SELECT 1 AS x FROM stage_unlocks u WHERE u.cache_id = ? AND u.stage_no = ? AND (
       u.callsign = ? OR u.callsign LIKE ? || '-%'
       OR EXISTS (SELECT 1 FROM account_callsigns ac WHERE ac.account_id = ?
                  AND (u.callsign = ac.callsign OR u.callsign LIKE ac.callsign || '-%'))
     ) LIMIT 1`,
  )
    .bind(cacheId, stageNo, base, base, acct)
    .first();
  return !!r;
}

/**
 * Where a find on this cache is verified: a staged cache at its last stage, when that stage has a position; any
 * other cache at its own coordinates.
 */
export async function findPoint<C extends { id: number; lat?: number | null; lon?: number | null }>(
  env: Env,
  cache: C,
): Promise<C> {
  const last = await env.DB.prepare(
    "SELECT lat, lon FROM cache_stages WHERE cache_id = ? AND stage_no > 0 ORDER BY stage_no DESC LIMIT 1",
  )
    .bind(cache.id)
    .first<{ lat: number | null; lon: number | null }>();
  return last?.lat != null && last.lon != null ? { ...cache, lat: last.lat, lon: last.lon } : cache;
}

/** The log types that speak for the cache: its owner's alone. */
const OWNER_LOGS = new Set(["maintenance", "enabled", "disabled"]);

/** Is the logger the cache's owner: the owner's base call, or a call on the owner's account? */
async function isOwner(env: Env, ownerCall: string, loggerCall: string, accountId: string | null): Promise<boolean> {
  const owner = baseCall(ownerCall);
  if (baseCall(loggerCall) === owner) return true;
  const acct = accountId ?? (await baseHolder(env, baseCall(loggerCall)));
  return !!acct && (await baseHolder(env, owner)) === acct;
}

/**
 * Why this log is refused, or null when it may be written: any log on a cache the sysop removed, a find or a
 * did-not-find on a cache that is not active,
 * a find by the cache's owner (the owner's base call, or a call on the owner's account), a maintenance, enabled
 * or disabled log by anyone else, or a find on a staged
 * cache whose last stage the finder has not unlocked.
 */
export async function logRefusal(
  env: Env,
  cache: {
    id?: number;
    code: string;
    status: string;
    owner_call: string;
    source?: string | null;
    removed_at?: number | null;
  },
  loggerCall: string,
  /** found, dnf, note, maintenance, enabled or disabled; over the radio, the command (found, dnf, note) */
  logType: string,
  accountId: string | null,
): Promise<string | null> {
  // a suspended account writes nothing here, from the app or over the radio
  if (await callSuspended(env, loggerCall)) return SUSPENDED_TEXT;
  // a cache the sysop removed takes no log of any kind, and the refusal reads as for a code that names nothing
  if (cache.removed_at != null) return `unknown cache ${cache.code}`;
  if (OWNER_LOGS.has(logType) && !(await isOwner(env, cache.owner_call, loggerCall, accountId)))
    return `only the owner of ${cache.code} posts ${logType} logs`;
  if ((logType === "found" || logType === "dnf") && cache.status !== "active")
    return `${cache.code} is ${cache.status === "archived" ? "archived" : "disabled"} and takes no ${logType === "found" ? "finds" : "logs of a search"}`;
  if (logType === "found" && (!cache.source || cache.source === "native")) {
    if (await isOwner(env, cache.owner_call, loggerCall, accountId))
      return `you own ${cache.code}, so you cannot log it as found`;
  }
  if (logType === "found" && cache.id != null) {
    const last = await env.DB.prepare("SELECT MAX(stage_no) AS n FROM cache_stages WHERE cache_id = ?")
      .bind(cache.id)
      .first<{ n: number | null }>();
    if (last?.n && !(await hasUnlocked(env, cache.id, last.n, loggerCall, accountId)))
      return `unlock every stage of ${cache.code} first: a find needs its last stage`;
  }
  return null;
}
