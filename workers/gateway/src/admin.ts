// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * admin.ts — instance-operator (sysop) authorization. Instance-wide configuration — federation peers +
 * trust, FBB forwarding partners/rules, NET/ROM node routes — belongs to the ham who DEPLOYED this
 * instance, not to platform users. The operator is named by the `ADMIN_CALLSIGNS` env (comma-separated
 * licensed calls); a request is a sysop request when its session is bound to one of those calls, held
 * by the session's account and control-verified.
 * Absent env ⇒ no web sysop at all. Scripts reach the same endpoints with OPERATOR_SECRET; INGEST_SECRET
 * authorises only the ingest plane and never operator configuration.
 */
import type { Env } from "./env.js";
import { json } from "./http.js";
import { sessionIdentity, ingestOrServiceBoxOk, operatorSecretOk } from "./auth.js";
import { isCallsignVerified, listSysopVerifications, sysopVerify, sysopRevoke } from "./callsign.js";
import { handleAdminCallsign } from "./claims.js";
import { instanceOrigins } from "./origins.js";

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
 * May a session issued on `origin` administer this instance? Only one issued on an https address: a session
 * issued over plain http (a HAMNET address) has crossed the network unencrypted. An instance with no https
 * address at all is administered over http, since that is the only way in.
 */
function sysopOrigin(origin: string, env: Env): boolean {
  return origin.startsWith("https:") || !instanceOrigins(env).some((o) => o.startsWith("https:"));
}

/**
 * The signed-in session when its call is listed in ADMIN_CALLSIGNS and it was issued on an address that may
 * administer this instance. The session resolves only while its account holds the call's base call, so the
 * listed call is held by the session's own account.
 */
async function adminSession(req: Request, env: Env) {
  const admins = adminCalls(env);
  if (admins.size === 0) return null;
  const me = await sessionIdentity(req, env);
  return me && admins.has(me.callsign.toUpperCase()) && sysopOrigin(me.origin, env) ? me : null;
}

/**
 * Is the requester a signed-in instance operator? The session's call must be listed in ADMIN_CALLSIGNS,
 * held by the session's own account, and control-verified — the same proof the TX gate demands. A bare
 * string match would hand the operator role to whoever first signs up under the listed call.
 */
export async function isSysop(req: Request, env: Env): Promise<boolean> {
  const me = await adminSession(req, env);
  return !!me && (await isCallsignVerified(env, me.base));
}

/**
 * Guard a sysop-only endpoint: returns a 401/403 Response to short-circuit, or null to proceed. Pass
 * `{ allowOperatorSecret: true }` for endpoints the operator also drives from scripts with
 * `x-operator-secret`. The ingest secret is never accepted here.
 */
export async function requireSysop(
  req: Request,
  env: Env,
  opts: { allowOperatorSecret?: boolean } = {},
): Promise<Response | null> {
  if (opts.allowOperatorSecret && operatorSecretOk(req, env)) return null;
  if (await isSysop(req, env)) return null;
  // A machine that PRESENTED an operator secret but it was wrong (or none is configured) → 401 (bad
  // credential). A browser with no session / a non-operator session → 403.
  if (opts.allowOperatorSecret && req.headers.get("x-operator-secret") !== null)
    return new Response("unauthorized", { status: 401 });
  if (adminCalls(env).size === 0)
    return json({ error: "no instance operator configured (set ADMIN_CALLSIGNS)" }, { status: 403 });
  return json({ error: "instance-operator (sysop) access required" }, { status: 403 });
}

/**
 * Guard an ingest-plane endpoint the ingest box itself calls with its INGEST_SECRET, or with its own key once
 * the sysop lets the box run this instance's services — delivering what its radios heard (the NET/ROM node mirror, heard federation
 * beacons and sync pages) or reading the forwarding partner list its FBB scheduler dials. The operator
 * reaches the same endpoints too.
 */
export async function requireIngestOrOperator(req: Request, env: Env): Promise<Response | null> {
  if (ingestOrServiceBoxOk(req, env)) return null;
  if (req.headers.get("x-ingest-secret") !== null) return new Response("unauthorized", { status: 401 });
  return requireSysop(req, env, { allowOperatorSecret: true });
}

/**
 * GET /api/admin/whoami — lets the web app decide whether to reveal the operator admin surface. The
 * unverified holder of an ADMIN_CALLSIGNS call is told what is missing (`pending: "verify"`); nobody
 * else learns anything about the admin list.
 */
export async function handleAdminWhoami(req: Request, env: Env): Promise<Response> {
  const callsign = (await sessionIdentity(req, env))?.callsign ?? null;
  // the holder of an ADMIN_CALLSIGNS call that is not yet control-verified: the operator on a fresh
  // instance, who still has to confirm the call
  const admin = await adminSession(req, env);
  const sysop = !!admin && (await isCallsignVerified(env, admin.base));
  const pending = admin && !sysop ? { pending: "verify" as const } : {};
  return json({ sysop, callsign, configured: adminCalls(env).size > 0, ...pending });
}

/** /api/admin/verifications[/:callsign] — list, add and revoke sysop manual verifications. Sysop-only. */
export async function handleAdminVerifications(req: Request, env: Env, callsign?: string): Promise<Response> {
  const denied = await requireSysop(req, env);
  if (denied) return denied;
  const me = await sessionIdentity(req, env);
  const m = req.method;
  if (callsign === undefined && m === "GET") return listSysopVerifications(env);
  if (callsign === undefined && m === "POST") return sysopVerify(req, env, me!.callsign);
  if (callsign !== undefined && m === "DELETE") return sysopRevoke(env, callsign, me!.callsign);
  return new Response("method not allowed", { status: 405 });
}

/** /api/admin/callsigns/:callsign — look a call up, or release it from its holder (claims.ts). Sysop-only. */
export async function handleAdminCallsigns(req: Request, env: Env, callsign: string): Promise<Response> {
  const denied = await requireSysop(req, env);
  if (denied) return denied;
  const me = await sessionIdentity(req, env);
  return handleAdminCallsign(req, env, callsign, me!.callsign);
}
