// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { isCallsignVerified } from "./callsign.js";

/**
 * Announce a verified find to APRS-IS — ONLY if: account opted in AND callsign is verified.
 * Publishes a STATUS (not a position) so it never feeds the spoofable position pool, and is
 * excluded from verification by construction. The ingest box publishes via third-party format.
 */
export async function maybeAnnounceFind(
  env: Env, callsign: string, cacheCode: string, cacheTitle?: string,
): Promise<boolean> {
  const acct = await env.DB.prepare("SELECT announce_is, announce_tocall FROM accounts WHERE callsign = ?")
    .bind(callsign).first<{ announce_is: number; announce_tocall: string }>();
  if (!acct?.announce_is) return false;
  if (!(await isCallsignVerified(env, callsign))) return false;

  const title = cacheTitle ? ` (${cacheTitle})` : "";
  const payload = `>Found ${cacheCode}${title} via aprscaching.com`.slice(0, 120);
  await env.DB.prepare(
    "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?,?,?, 'status', ?)",
  ).bind(Math.floor(Date.now() / 1000), callsign, acct.announce_tocall ?? "APZACG", payload).run();
  return true;
}
