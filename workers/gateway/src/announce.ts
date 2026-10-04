// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { isCallsignVerified } from "./callsign.js";
import { json } from "./app.js";
import { sessionIdentity } from "./auth.js";
import { baseCall } from "@aprscaching/aprs";

/**
 * Announce a verified find to APRS-IS — ONLY if: account opted in AND callsign is verified.
 * Publishes a STATUS (not a position) so it never feeds the spoofable position pool, and is
 * excluded from verification by construction. The ingest box publishes via third-party format.
 */
export async function maybeAnnounceFind(
  env: Env,
  callsign: string,
  cacheCode: string,
  cacheTitle?: string,
): Promise<boolean> {
  // the switch belongs to the account that holds the call, so a find from any of its SSIDs follows it
  const acct = await env.DB.prepare(
    `SELECT a.announce_is, a.announce_tocall FROM accounts a
       JOIN account_callsigns ac ON ac.account_id = a.account_id WHERE ac.callsign = ?`,
  )
    .bind(baseCall(callsign.toUpperCase()))
    .first<{ announce_is: number; announce_tocall: string }>();
  if (!acct?.announce_is) return false;
  if (!(await isCallsignVerified(env, callsign))) return false;

  // A title or code can arrive by import or federation without the request schema's check, and the
  // status goes out as one APRS-IS line, so control characters are dropped here too.
  const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const t = cacheTitle ? oneLine(cacheTitle) : "";
  const title = t ? ` (${t})` : "";
  const payload = `>Found ${oneLine(cacheCode)}${title} via aprscaching.net`.slice(0, 120);
  await env.DB.prepare("INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?,?,?, 'status', ?)")
    .bind(nowS(), callsign, acct.announce_tocall ?? "APZACG", payload)
    .run();
  return true;
}

/** GET / POST /api/announce — the signed-in account's opt-in to announcing its verified finds on APRS-IS. */
export async function handleAnnouncePrefs(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { on?: unknown };
    if (typeof b.on !== "boolean") return json({ error: "on must be true or false" }, { status: 400 });
    await env.DB.prepare("UPDATE accounts SET announce_is = ? WHERE account_id = ?")
      .bind(b.on ? 1 : 0, me.accountId)
      .run();
  }
  const row = await env.DB.prepare("SELECT announce_is FROM accounts WHERE account_id = ?")
    .bind(me.accountId)
    .first<{ announce_is: number }>();
  return json({ on: (row?.announce_is ?? 0) === 1 });
}
