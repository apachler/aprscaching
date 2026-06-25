import type { Env } from "./env.js";
import { json } from "./app.js";
import { randomChallenge, bytesToB64url, b64urlToBytes, verifyRegistration, verifyAssertion } from "./webauthn.js";

/**
 * Identity = callsign + passkey (WebAuthn), with email magic-link recovery (email.ts). Passkey
 * ceremonies are verified in webauthn.ts (Web Crypto, runtime-agnostic). Sessions are a signed
 * (HMAC) cookie bound to the callsign of the durable account behind it.
 */

const SESSION_COOKIE = "acs";
const CHALLENGE_TTL = 300;

function authOrigins(req: Request, env: Env): string[] {
  const o = env.APP_URL ?? req.headers.get("Origin");
  return o ? [o] : [];
}
function rpId(req: Request, env: Env): string {
  if (env.RP_ID) return env.RP_ID;
  const o = env.APP_URL ?? req.headers.get("Origin");
  try { return o ? new URL(o).hostname : "localhost"; } catch { return "localhost"; }
}
async function storeChallenge(env: Env, cs: string, kind: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO auth_challenges (id, callsign, kind, value, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), cs, kind, value, Math.floor(Date.now() / 1000) + CHALLENGE_TTL).run();
}
async function takeChallenge(env: Env, cs: string, kind: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id, value FROM auth_challenges WHERE callsign=? AND kind=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1")
    .bind(cs, kind, Math.floor(Date.now() / 1000)).first<{ id: string; value: string }>();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM auth_challenges WHERE id=?").bind(row.id).run();
  return row.value;
}

/** POST /auth/claim {callsign} — probe whether a callsign exists / has a passkey (no side effects). */
export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = String(callsign ?? "").toUpperCase().trim();
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const existing = await env.DB.prepare("SELECT callsign FROM accounts WHERE callsign=?").bind(cs).first();
  const hasPasskey = existing ? await env.DB.prepare("SELECT 1 FROM credentials WHERE callsign=? LIMIT 1").bind(cs).first() : null;
  return json({ callsign: cs, exists: !!existing, hasPasskey: !!hasPasskey });
}

type Cred = { id?: string; response?: { clientDataJSON: string; attestationObject?: string; authenticatorData?: string; signature?: string; transports?: string[] } };

/** POST /auth/passkey/register/begin {callsign, email?} — PublicKeyCredentialCreationOptions. */
export async function handlePasskeyRegisterBegin(req: Request, env: Env): Promise<Response> {
  const { callsign, email } = (await req.json().catch(() => ({}))) as { callsign?: string; email?: string };
  const cs = String(callsign ?? "").toUpperCase().trim();
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const existing = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?").bind(cs).first<{ account_id: string }>();
  let accountId: string;
  if (existing) {
    if ((await sessionCallsign(req, env)) !== cs) return json({ error: "callsign already claimed — sign in instead" }, { status: 409 });
    accountId = existing.account_id;
  } else {
    accountId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO accounts (callsign, account_id, email, verified, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind(cs, accountId, email ? String(email).trim().toLowerCase() : null, Math.floor(Date.now() / 1000)).run();
  }
  const challenge = randomChallenge();
  await storeChallenge(env, cs, "webauthn_reg", challenge);
  const excl = await env.DB.prepare("SELECT id FROM credentials WHERE callsign=?").bind(cs).all<{ id: string }>();
  return json({
    challenge, rp: { id: rpId(req, env), name: "APRScaching" },
    user: { id: bytesToB64url(new TextEncoder().encode(accountId)), name: cs, displayName: cs },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    attestation: "none", timeout: 60000,
    excludeCredentials: (excl.results ?? []).map((c) => ({ type: "public-key", id: c.id })),
  });
}

/** POST /auth/passkey/register/finish {callsign, credential} — verify attestation, open session. */
export async function handlePasskeyRegisterFinish(req: Request, env: Env): Promise<Response> {
  const { callsign, credential } = (await req.json().catch(() => ({}))) as { callsign?: string; credential?: Cred };
  const cs = String(callsign ?? "").toUpperCase().trim();
  const challenge = await takeChallenge(env, cs, "webauthn_reg");
  if (!challenge || !credential?.response?.attestationObject) return json({ error: "no pending registration" }, { status: 400 });
  try {
    const r = await verifyRegistration({
      clientDataJSON: b64urlToBytes(credential.response.clientDataJSON),
      attestationObject: b64urlToBytes(credential.response.attestationObject),
      challenge, origins: authOrigins(req, env), rpId: rpId(req, env),
    });
    await env.DB.prepare("INSERT OR REPLACE INTO credentials (id, callsign, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(r.credentialId, cs, r.coseKey, r.signCount, JSON.stringify(credential.response.transports ?? []), Math.floor(Date.now() / 1000)).run();
    return json({ ok: true, callsign: cs }, { headers: { "set-cookie": await issueSessionCookie(cs, env) } });
  } catch (e) { return json({ error: "registration failed: " + (e as Error).message }, { status: 400 }); }
}

/** POST /auth/passkey/login/begin {callsign} — PublicKeyCredentialRequestOptions. */
export async function handlePasskeyLoginBegin(req: Request, env: Env): Promise<Response> {
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = String(callsign ?? "").toUpperCase().trim();
  const creds = await env.DB.prepare("SELECT id FROM credentials WHERE callsign=?").bind(cs).all<{ id: string }>();
  if (!creds.results?.length) return json({ error: "no passkey for this callsign" }, { status: 404 });
  const challenge = randomChallenge();
  await storeChallenge(env, cs, "webauthn_login", challenge);
  return json({
    challenge, rpId: rpId(req, env), userVerification: "preferred", timeout: 60000,
    allowCredentials: creds.results.map((c) => ({ type: "public-key", id: c.id })),
  });
}

/** POST /auth/passkey/login/finish {callsign, credential} — verify assertion, open session. */
export async function handlePasskeyLoginFinish(req: Request, env: Env): Promise<Response> {
  const { callsign, credential } = (await req.json().catch(() => ({}))) as { callsign?: string; credential?: Cred };
  const cs = String(callsign ?? "").toUpperCase().trim();
  const challenge = await takeChallenge(env, cs, "webauthn_login");
  if (!challenge || !credential?.id || !credential?.response?.signature) return json({ error: "no pending login" }, { status: 400 });
  const cred = await env.DB.prepare("SELECT public_key, counter FROM credentials WHERE id=? AND callsign=?")
    .bind(credential.id, cs).first<{ public_key: string; counter: number }>();
  if (!cred) return json({ error: "unknown credential" }, { status: 400 });
  try {
    const r = await verifyAssertion({
      clientDataJSON: b64urlToBytes(credential.response.clientDataJSON),
      authenticatorData: b64urlToBytes(credential.response.authenticatorData!),
      signature: b64urlToBytes(credential.response.signature),
      coseKey: cred.public_key, storedCounter: cred.counter,
      challenge, origins: authOrigins(req, env), rpId: rpId(req, env),
    });
    await env.DB.prepare("UPDATE credentials SET counter=? WHERE id=?").bind(r.newCounter, credential.id).run();
    return json({ ok: true, callsign: cs }, { headers: { "set-cookie": await issueSessionCookie(cs, env) } });
  } catch (e) { return json({ error: "login failed: " + (e as Error).message }, { status: 400 }); }
}

/**
 * POST /auth/callsign {callsign} — change the signed-in account's active callsign (S5). The new
 * call is set immediately but UNVERIFIED (must re-run the APRS challenge); passkeys follow the
 * account so login still works; history under the previous call is left intact (audit-true). The
 * change is recorded in callsign_history and the session cookie is re-bound to the new call.
 */
export async function handleChangeCallsign(req: Request, env: Env): Promise<Response> {
  const sess = await sessionCallsign(req, env);
  if (!sess) return json({ error: "sign in first" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const next = String(callsign ?? "").toUpperCase().trim();
  if (next.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const cur = sess.toUpperCase();
  if (next === cur) return json({ error: "that is already your callsign" }, { status: 400 });
  const me = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?").bind(cur).first<{ account_id: string }>();
  if (!me) return json({ error: "account not found" }, { status: 404 });
  const taken = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?").bind(next).first<{ account_id: string }>();
  if (taken && taken.account_id !== me.account_id) return json({ error: "callsign already claimed by another account" }, { status: 409 });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET callsign=?, verified=0, verify_method=NULL, verified_at=NULL WHERE account_id=?").bind(next, me.account_id),
    env.DB.prepare("UPDATE credentials SET callsign=? WHERE callsign=?").bind(next, cur),
    env.DB.prepare("INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?,?,?,0)").bind(me.account_id, next, now),
  ]);
  return json({ ok: true, callsign: next }, { headers: { "set-cookie": await issueSessionCookie(next, env) } });
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
