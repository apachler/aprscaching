// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * admin.ts — instance-operator (sysop) authorization. Instance-wide configuration — federation peers +
 * trust, FBB forwarding partners/rules, NET/ROM node routes — belongs to the ham who DEPLOYED this
 * instance, not to platform users. The operator is named by the `ADMIN_CALLSIGNS` env (comma-separated
 * licensed calls); a request is a sysop request when its session is bound to one of those calls, held
 * by the session's account and control-verified.
 * Absent env ⇒ no web sysop at all (the config endpoints are locked; the ingest still uses INGEST_SECRET).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionCallsign, sessionAccountId, secretOk } from "./auth.js";
import { isCallsignVerified } from "./callsign.js";

/** The set of licensed calls allowed to administer this instance (uppercased). Empty ⇒ no web sysop. */
export function adminCalls(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_CALLSIGNS ?? "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Is the requester a signed-in instance operator? The session's call must be listed in ADMIN_CALLSIGNS,
 * its base call must be held by the session's own account, and that call must be control-verified —
 * the same proof the TX gate demands. A bare string match would hand the operator role to whoever
 * first signs up under the listed call.
 */
export async function isSysop(req: Request, env: Env): Promise<boolean> {
  const admins = adminCalls(env);
  if (admins.size === 0) return false;
  const me = await sessionAccountId(req, env);
  if (!me || !admins.has(me.callsign.toUpperCase())) return false;
  const base = me.callsign.toUpperCase().split("-")[0]!;
  const held = await env.DB.prepare(
    "SELECT verified FROM account_callsigns WHERE account_id=? AND callsign=? AND verified=1",
  )
    .bind(me.accountId, base)
    .first<{ verified: number }>();
  return !!held && (await isCallsignVerified(env, base));
}

/** Ingest machine credential (shared with the forwarding pool / node mirror). */
const ingestOk = (req: Request, env: Env): boolean => secretOk(req.headers.get("x-ingest-secret"), env.INGEST_SECRET);

/**
 * Guard a sysop-only endpoint: returns a 401/403 Response to short-circuit, or null to proceed. Pass
 * `{ allowIngest: true }` for endpoints the operator-local ingest also legitimately reads/writes with its
 * secret (e.g. the forwarding partner list the forwarder loads, or the node-table mirror it posts).
 */
export async function requireSysop(
  req: Request,
  env: Env,
  opts: { allowIngest?: boolean } = {},
): Promise<Response | null> {
  if (opts.allowIngest && ingestOk(req, env)) return null;
  if (await isSysop(req, env)) return null;
  // A machine that PRESENTED an ingest secret but it was wrong → 401 (bad credential), matching the
  // established ingest-auth contract. A browser with no session / a non-operator session → 403.
  if (opts.allowIngest && req.headers.get("x-ingest-secret") !== null)
    return new Response("unauthorized", { status: 401 });
  if (adminCalls(env).size === 0)
    return json({ error: "no instance operator configured (set ADMIN_CALLSIGNS)" }, { status: 403 });
  return json({ error: "instance-operator (sysop) access required" }, { status: 403 });
}

/** GET /api/admin/whoami — lets the web app decide whether to reveal the operator admin surface. */
export async function handleAdminWhoami(req: Request, env: Env): Promise<Response> {
  const callsign = await sessionCallsign(req, env);
  return json({ sysop: await isSysop(req, env), callsign, configured: adminCalls(env).size > 0 });
}
