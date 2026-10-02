// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * findrules.ts — the game's rules for who may log what, the same for a log from the app, from the offline queue
 * and over the radio:
 *
 *  - a find counts once per person: any SSID of the logger's base call, or any callsign on their account, holds it;
 *  - an archived or disabled cache takes no find and no did-not-find (a note or an owner's maintenance log stays
 *    possible, so the owner can say why and bring it back);
 *  - an owner does not find their own cache.
 *
 * Finds are stored under the exact call a player logged with (OE8APR-7); everything that counts them for a person
 * (the leaderboard, profiles, badges, who may rate) groups by the base call, through {@link baseSql}.
 */
import type { Env } from "./env.js";
import { baseHolder } from "./auth.js";
import { baseCall } from "@aprscaching/aprs";

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

/**
 * Why this log is refused, or null when it may be written: a find or a did-not-find on a cache that is not active,
 * or a find by the cache's owner (the owner's base call, or a call on the owner's account).
 */
export async function logRefusal(
  env: Env,
  cache: { code: string; status: string; owner_call: string; source?: string | null },
  loggerCall: string,
  /** found, dnf, note, maintenance, enabled or disabled; over the radio, the command (found, dnf, note) */
  logType: string,
  accountId: string | null,
): Promise<string | null> {
  if ((logType === "found" || logType === "dnf") && cache.status !== "active")
    return `${cache.code} is ${cache.status === "archived" ? "archived" : "disabled"} and takes no ${logType === "found" ? "finds" : "logs of a search"}`;
  if (logType === "found" && (!cache.source || cache.source === "native")) {
    const owner = baseCall(cache.owner_call);
    if (baseCall(loggerCall) === owner) return `you own ${cache.code}, so you cannot log it as found`;
    const acct = accountId ?? (await baseHolder(env, baseCall(loggerCall)));
    if (acct && (await baseHolder(env, owner)) === acct) return `you own ${cache.code}, so you cannot log it as found`;
  }
  return null;
}
