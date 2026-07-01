/**
 * admin.ts — instance-operator (sysop) authorization. Instance-wide configuration — federation peers +
 * trust, FBB forwarding partners/rules, NET/ROM node routes — belongs to the ham who DEPLOYED this
 * instance, not to platform users. The operator is named by the `ADMIN_CALLSIGNS` env (comma-separated
 * licensed calls); a request is a sysop request when its session cookie is bound to one of those calls.
 * Absent env ⇒ no web sysop at all (the config endpoints are locked; the ingest still uses INGEST_SECRET).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionCallsign } from "./auth.js";

/** The set of licensed calls allowed to administer this instance (uppercased). Empty ⇒ no web sysop. */
export function adminCalls(env: Env): Set<string> {
  return new Set((env.ADMIN_CALLSIGNS ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean));
}

/** Is the requester a signed-in instance operator? */
export async function isSysop(req: Request, env: Env): Promise<boolean> {
  const admins = adminCalls(env);
  if (admins.size === 0) return false;
  const cs = await sessionCallsign(req, env);
  return !!cs && admins.has(cs.toUpperCase());
}

/** Ingest machine credential (shared with the forwarding pool / node mirror). */
const ingestOk = (req: Request, env: Env): boolean => req.headers.get("x-ingest-secret") === env.INGEST_SECRET;

/**
 * Guard a sysop-only endpoint: returns a 401/403 Response to short-circuit, or null to proceed. Pass
 * `{ allowIngest: true }` for endpoints the operator-local ingest also legitimately reads/writes with its
 * secret (e.g. the forwarding partner list the forwarder loads, or the node-table mirror it posts).
 */
export async function requireSysop(req: Request, env: Env, opts: { allowIngest?: boolean } = {}): Promise<Response | null> {
  if (opts.allowIngest && ingestOk(req, env)) return null;
  if (await isSysop(req, env)) return null;
  if (adminCalls(env).size === 0) return json({ error: "no instance operator configured (set ADMIN_CALLSIGNS)" }, { status: 403 });
  return json({ error: "instance-operator (sysop) access required" }, { status: 403 });
}

/** GET /api/admin/whoami — lets the web app decide whether to reveal the operator admin surface. */
export async function handleAdminWhoami(req: Request, env: Env): Promise<Response> {
  const callsign = await sessionCallsign(req, env);
  return json({ sysop: await isSysop(req, env), callsign, configured: adminCalls(env).size > 0 });
}
