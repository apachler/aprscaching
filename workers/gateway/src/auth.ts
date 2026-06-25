import type { Env } from "./env.js";
import { json } from "./app.js";

/**
 * Auth scaffold. Identity = callsign + passkey (WebAuthn). Logging is never blocked by this;
 * an unverified account can still log finds (flagged). Callsign-CONTROL verification is a
 * separate async badge (see verifyCallsign*) that gates the APRS-IS announce feature.
 *
 * Integrate a WebAuthn lib (e.g. @simplewebauthn/server, confirm edge-runtime support) at the
 * marked TODOs. Sessions here use a signed cookie kept simple for the scaffold.
 */

const SESSION_COOKIE = "acs";

export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const { callsign } = (await req.json()) as { callsign: string };
  const cs = callsign.toUpperCase().trim();
  const existing = await env.DB.prepare("SELECT callsign FROM accounts WHERE callsign = ?").bind(cs).first();
  if (existing) {
    // account exists -> begin passkey LOGIN ceremony
    // TODO: generateAuthenticationOptions() and store challenge
    return json({ mode: "login", callsign: cs, challenge: "TODO_webauthn_challenge" });
  }
  // new callsign -> create account + begin passkey REGISTRATION ceremony
  await env.DB.prepare(
    "INSERT INTO accounts (callsign, account_id, verified, created_at) VALUES (?, ?, 0, ?)",
  ).bind(cs, crypto.randomUUID(), Math.floor(Date.now() / 1000)).run();
  // TODO: generateRegistrationOptions() and store challenge
  return json({ mode: "register", callsign: cs, challenge: "TODO_webauthn_challenge" });
}

export async function handlePasskeyVerify(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { callsign: string; assertion: unknown };
  // TODO: verifyRegistrationResponse / verifyAuthenticationResponse, persist/lookup credential.
  // On success, issue a session bound to the callsign.
  return json({ ok: true, callsign: body.callsign.toUpperCase() }, {
    headers: { "set-cookie": await issueSessionCookie(body.callsign.toUpperCase(), env) },
  });
}

/** Returns the signed-in callsign, or null. Used to attribute logs and gate announce. */
export async function sessionCallsign(req: Request, env: Env): Promise<string | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)acs=([^;]+)/.exec(cookie);
  if (!m) return null;
  return verifySession(m[1]!, env);
}

/** Set-Cookie header value for a session bound to a callsign (the durable account behind it). */
export async function issueSessionCookie(callsign: string, env: Env): Promise<string> {
  const token = await signSession(callsign.toUpperCase(), env);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

/** GET /auth/session — "who am I": the signed-in callsign + verification + email, or null. */
export async function handleSession(req: Request, env: Env): Promise<Response> {
  const callsign = await sessionCallsign(req, env);
  if (!callsign) return json({ callsign: null });
  const acct = await env.DB.prepare("SELECT verified, email FROM accounts WHERE callsign = ?")
    .bind(callsign).first<{ verified: number; email: string | null }>();
  return json({ callsign, verified: !!acct?.verified, email: acct?.email ?? null });
}

/** POST /auth/logout — clear the session cookie. */
export async function handleLogout(): Promise<Response> {
  return json({ ok: true }, { headers: { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } });
}

// --- minimal signed session (HMAC). Replace with your preferred session strategy. ---
async function key(env: Env): Promise<CryptoKey> {
  const secret = new TextEncoder().encode(env.INGEST_SECRET + ":session");
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(callsign: string, env: Env): Promise<string> {
  const payload = `${callsign}.${Date.now()}`;
  const sig = await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(payload));
  return `${btoa(payload)}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}
async function verifySession(token: string, env: Env): Promise<string | null> {
  try {
    const [p, s] = token.split(".");
    const payload = atob(p!);
    const sig = Uint8Array.from(atob(s!), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", await key(env), sig, new TextEncoder().encode(payload));
    return ok ? payload.split(".")[0]! : null;
  } catch { return null; }
}
