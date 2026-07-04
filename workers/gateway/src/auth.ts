// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { json } from "./app.js";
import { randomChallenge, bytesToB64url, b64urlToBytes, verifyRegistration, verifyAssertion } from "./webauthn.js";
import { rateLimitedDurable, clientIp } from "./corroborate_privacy.js";

/**
 * Identity = callsign + passkey (WebAuthn), with email magic-link recovery (email.ts). Passkey
 * ceremonies are verified in webauthn.ts (Web Crypto, runtime-agnostic). Sessions are a signed
 * (HMAC) cookie bound to the callsign of the durable account behind it.
 */

const SESSION_COOKIE = "acs";
const CHALLENGE_TTL = 300;

/** The expected WebAuthn origin/rpId MUST come from configuration. Falling back to the
 *  request's Origin header validates the binding against an attacker-supplied value — any site could
 *  satisfy the ceremony. Unconfigured ⇒ null, and the passkey endpoints refuse (fail closed);
 *  the email magic-link path is unaffected. */
function authOrigins(env: Env): string[] | null {
  return env.APP_URL ? [env.APP_URL] : null;
}
function rpId(env: Env): string | null {
  if (env.RP_ID) return env.RP_ID;
  try {
    return env.APP_URL ? new URL(env.APP_URL).hostname : null;
  } catch {
    return null;
  }
}
function webauthnUnconfigured(): Response {
  return json(
    { error: "passkeys require APP_URL (and optionally RP_ID) to be configured on this instance" },
    { status: 503 },
  );
}
async function storeChallenge(env: Env, cs: string, kind: string, value: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    // reap expired ceremonies while we're here — abandoned begins must not accumulate
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO auth_challenges (id, callsign, kind, value, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      crypto.randomUUID(),
      cs,
      kind,
      value,
      now + CHALLENGE_TTL,
    ),
  ]);
}
async function takeChallenge(env: Env, cs: string, kind: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id, value FROM auth_challenges WHERE callsign=? AND kind=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
  )
    .bind(cs, kind, Math.floor(Date.now() / 1000))
    .first<{ id: string; value: string }>();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM auth_challenges WHERE id=?").bind(row.id).run();
  return row.value;
}

/** POST /auth/claim {callsign} — probe whether a callsign exists / has a passkey (no side effects). */
export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const existing = await env.DB.prepare("SELECT callsign FROM accounts WHERE callsign=?").bind(cs).first();
  const hasPasskey = existing
    ? await env.DB.prepare("SELECT 1 FROM credentials WHERE callsign=? LIMIT 1").bind(cs).first()
    : null;
  return json({ callsign: cs, exists: !!existing, hasPasskey: !!hasPasskey });
}

type Cred = {
  id?: string;
  response?: {
    clientDataJSON: string;
    attestationObject?: string;
    authenticatorData?: string;
    signature?: string;
    transports?: string[];
  };
};

/** POST /auth/passkey/register/begin {callsign, email?} — PublicKeyCredentialCreationOptions. */
export async function handlePasskeyRegisterBegin(req: Request, env: Env): Promise<Response> {
  const origins = authOrigins(env);
  const rp = rpId(env);
  if (!origins || !rp) return webauthnUnconfigured();
  if (await rateLimitedDurable(env, `pkbegin:${clientIp(req, env)}`, Date.now(), 20, 60_000))
    return json({ error: "rate limited" }, { status: 429 });
  const { callsign, email } = (await req.json().catch(() => ({}))) as { callsign?: string; email?: string };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const existing = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?")
    .bind(cs)
    .first<{ account_id: string }>();
  let accountId: string;
  let pendingNew = false;
  if (existing) {
    if ((await sessionCallsign(req, env)) !== cs)
      return json({ error: "callsign already claimed — sign in instead" }, { status: 409 });
    accountId = existing.account_id;
  } else {
    // Do NOT insert the account here — an unauthenticated begin that pre-claimed the callsign row
    // would let anyone squat W1AW and lock out the real holder. The provisional account id (and
    // email) ride inside the stored challenge and only become a row once the passkey ceremony
    // completes in register/finish.
    accountId = crypto.randomUUID();
    pendingNew = true;
  }
  const challenge = randomChallenge();
  await storeChallenge(
    env,
    cs,
    "webauthn_reg",
    JSON.stringify({
      c: challenge,
      ...(pendingNew ? { a: accountId, e: email ? String(email).trim().toLowerCase() : null } : {}),
    }),
  );
  const excl = await env.DB.prepare("SELECT id FROM credentials WHERE callsign=?").bind(cs).all<{ id: string }>();
  return json({
    challenge,
    rp: { id: rp, name: "APRScaching" },
    user: { id: bytesToB64url(new TextEncoder().encode(accountId)), name: cs, displayName: cs },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    attestation: "none",
    timeout: 60000,
    excludeCredentials: (excl.results ?? []).map((c) => ({ type: "public-key", id: c.id })),
  });
}

/** POST /auth/passkey/register/finish {callsign, credential} — verify attestation, open session. */
export async function handlePasskeyRegisterFinish(req: Request, env: Env): Promise<Response> {
  const origins = authOrigins(env);
  const rp = rpId(env);
  if (!origins || !rp) return webauthnUnconfigured();
  const { callsign, credential } = (await req.json().catch(() => ({}))) as { callsign?: string; credential?: Cred };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  const stashed = await takeChallenge(env, cs, "webauthn_reg");
  if (!stashed || !credential?.response?.attestationObject)
    return json({ error: "no pending registration" }, { status: 400 });
  // The stash is {c: challenge, a?: provisional accountId, e?: email} — `a` present means the
  // account does not exist yet and is created below only once the ceremony verifies.
  let challenge: string;
  let pending: { a?: string; e?: string | null } = {};
  try {
    const j = JSON.parse(stashed) as { c: string; a?: string; e?: string | null };
    challenge = j.c;
    pending = j;
  } catch {
    challenge = stashed; // a bare (non-JSON) stash is the challenge itself — an existing account
  }
  try {
    const r = await verifyRegistration({
      clientDataJSON: b64urlToBytes(credential.response.clientDataJSON),
      attestationObject: b64urlToBytes(credential.response.attestationObject),
      challenge,
      origins,
      rpId: rp,
    });
    if (pending.a) {
      // Passkey proven — NOW create the account. If the callsign was claimed through another path
      // during the ceremony window, refuse rather than bind this passkey to someone else's account.
      const now = Math.floor(Date.now() / 1000);
      const raced = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?")
        .bind(cs)
        .first<{ account_id: string }>();
      if (raced) return json({ error: "callsign already claimed — sign in instead" }, { status: 409 });
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO accounts (callsign, account_id, email, verified, created_at) VALUES (?, ?, ?, 0, ?)",
        ).bind(cs, pending.a, pending.e ?? null, now),
        // seed the held-callsign set with this call as the account's primary (the passkey binds here)
        env.DB.prepare(
          "INSERT OR IGNORE INTO account_callsigns (account_id, callsign, verified, is_primary, added_at) VALUES (?, ?, 0, 1, ?)",
        ).bind(pending.a, cs.split("-")[0], now),
      ]);
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO credentials (id, callsign, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        r.credentialId,
        cs,
        r.coseKey,
        r.signCount,
        JSON.stringify(credential.response.transports ?? []),
        Math.floor(Date.now() / 1000),
      )
      .run();
    return json({ ok: true, callsign: cs }, { headers: { "set-cookie": await issueSessionCookie(cs, env) } });
  } catch (e) {
    return json({ error: "registration failed: " + (e as Error).message }, { status: 400 });
  }
}

/** POST /auth/passkey/login/begin {callsign} — PublicKeyCredentialRequestOptions. */
export async function handlePasskeyLoginBegin(req: Request, env: Env): Promise<Response> {
  const origins = authOrigins(env);
  const rp = rpId(env);
  if (!origins || !rp) return webauthnUnconfigured();
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  const creds = await env.DB.prepare("SELECT id FROM credentials WHERE callsign=?").bind(cs).all<{ id: string }>();
  if (!creds.results?.length) return json({ error: "no passkey for this callsign" }, { status: 404 });
  const challenge = randomChallenge();
  await storeChallenge(env, cs, "webauthn_login", challenge);
  return json({
    challenge,
    rpId: rp,
    userVerification: "preferred",
    timeout: 60000,
    allowCredentials: creds.results.map((c) => ({ type: "public-key", id: c.id })),
  });
}

/** POST /auth/passkey/login/finish {callsign, credential} — verify assertion, open session. */
export async function handlePasskeyLoginFinish(req: Request, env: Env): Promise<Response> {
  const origins = authOrigins(env);
  const rp = rpId(env);
  if (!origins || !rp) return webauthnUnconfigured();
  const { callsign, credential } = (await req.json().catch(() => ({}))) as { callsign?: string; credential?: Cred };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  const challenge = await takeChallenge(env, cs, "webauthn_login");
  if (!challenge || !credential?.id || !credential?.response?.signature)
    return json({ error: "no pending login" }, { status: 400 });
  const cred = await env.DB.prepare("SELECT public_key, counter FROM credentials WHERE id=? AND callsign=?")
    .bind(credential.id, cs)
    .first<{ public_key: string; counter: number }>();
  if (!cred) return json({ error: "unknown credential" }, { status: 400 });
  try {
    const r = await verifyAssertion({
      clientDataJSON: b64urlToBytes(credential.response.clientDataJSON),
      authenticatorData: b64urlToBytes(credential.response.authenticatorData!),
      signature: b64urlToBytes(credential.response.signature),
      coseKey: cred.public_key,
      storedCounter: cred.counter,
      challenge,
      origins,
      rpId: rp,
    });
    await env.DB.prepare("UPDATE credentials SET counter=? WHERE id=?").bind(r.newCounter, credential.id).run();
    return json({ ok: true, callsign: cs }, { headers: { "set-cookie": await issueSessionCookie(cs, env) } });
  } catch (e) {
    return json({ error: "login failed: " + (e as Error).message }, { status: 400 });
  }
}

const baseOf = (c: string) => c.toUpperCase().trim().split("-")[0] ?? "";

/**
 * Resolve the durable account behind the signed-in session — the single canonical resolver used
 * everywhere (`watch.ts` re-exports a bare-string wrapper over it). A person holds one or more BASE
 * calls in `account_callsigns` (the durable multi-call model), so that mapping is authoritative and
 * is consulted first; the `accounts` row (active-call anchor) is the fallback for a single-call
 * account that predates any `account_callsigns` entry. Returns the account id + the active callsign.
 */
export async function sessionAccountId(
  req: Request,
  env: Env,
): Promise<{ accountId: string; callsign: string } | null> {
  const cur = await sessionCallsign(req, env);
  if (!cur) return null;
  const viaBase = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
    .bind(baseOf(cur))
    .first<{ account_id: string }>();
  if (viaBase) return { accountId: viaBase.account_id, callsign: cur };
  const me = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?")
    .bind(cur)
    .first<{ account_id: string }>();
  return me ? { accountId: me.account_id, callsign: cur } : null;
}

/**
 * GET /auth/callsigns — the held base calls of the signed-in account, with verification state and
 * which one is currently active / primary. The account (person) holds one or more base calls; the
 * passkey lives on the primary; the active call is whichever the session is bound to.
 */
export async function handleListCallsigns(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const active = baseOf(me.callsign);
  const rows =
    (
      await env.DB.prepare(
        "SELECT callsign, verified, is_primary FROM account_callsigns WHERE account_id=? ORDER BY is_primary DESC, added_at ASC, callsign ASC",
      )
        .bind(me.accountId)
        .all<{ callsign: string; verified: number; is_primary: number }>()
    ).results ?? [];
  return json({
    active,
    callsigns: rows.map((r) => ({
      callsign: r.callsign,
      verified: !!r.verified,
      isPrimary: !!r.is_primary,
      active: r.callsign === active,
    })),
  });
}

/**
 * POST /auth/callsigns {callsign} — add another base call to the signed-in account (unverified;
 * verify it via the APRS challenge). Does NOT change the active call. A base call can be held by
 * only one account, so a call already on another account is rejected.
 */
export async function handleAddCallsign(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const base = baseOf(String(callsign ?? ""));
  if (base.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const held = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
    .bind(base)
    .first<{ account_id: string }>();
  if (held)
    return json(
      held.account_id === me.accountId
        ? { error: "you already hold that callsign" }
        : { error: "callsign already held by another account" },
      { status: 409 },
    );
  await env.DB.prepare(
    "INSERT INTO account_callsigns (account_id, callsign, verified, is_primary, added_at) VALUES (?,?,0,0,?)",
  )
    .bind(me.accountId, base, Math.floor(Date.now() / 1000))
    .run();
  return json({ ok: true, callsign: base, verified: false });
}

/**
 * POST /auth/callsign {callsign} — switch the active operating callsign of the signed-in account.
 * Switching to a base call the account ALREADY HOLDS is non-destructive: its prior verification is
 * preserved (no re-challenge). Switching to a NEW base call adds it (unverified) and switches. The
 * passkey stays on the primary call (login is unaffected); the session cookie re-binds to the new
 * active call and the change is recorded in callsign_history.
 */
export async function handleChangeCallsign(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const next = baseOf(String(callsign ?? ""));
  if (next.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const cur = baseOf(me.callsign);
  if (next === cur) return json({ error: "that is already your active callsign" }, { status: 400 });
  // a base call held by a DIFFERENT account is off-limits
  const owner = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
    .bind(next)
    .first<{ account_id: string }>();
  if (owner && owner.account_id !== me.accountId)
    return json({ error: "callsign already held by another account" }, { status: 409 });
  const now = Math.floor(Date.now() / 1000);
  const held = await env.DB.prepare(
    "SELECT verified, method, verified_at FROM account_callsigns WHERE account_id=? AND callsign=?",
  )
    .bind(me.accountId, next)
    .first<{ verified: number; method: string | null; verified_at: number | null }>();
  const ops = [];
  if (held) {
    // already a held call — restore its verification state onto the active account row (no re-verify)
    ops.push(
      env.DB.prepare(
        "UPDATE accounts SET callsign=?, verified=?, verify_method=?, verified_at=? WHERE account_id=?",
      ).bind(next, held.verified, held.method, held.verified_at, me.accountId),
    );
  } else {
    // a brand-new base call — hold it (unverified) and switch to it
    ops.push(
      env.DB.prepare(
        "INSERT INTO account_callsigns (account_id, callsign, verified, is_primary, added_at) VALUES (?,?,0,0,?)",
      ).bind(me.accountId, next, now),
    );
    ops.push(
      env.DB.prepare(
        "UPDATE accounts SET callsign=?, verified=0, verify_method=NULL, verified_at=NULL WHERE account_id=?",
      ).bind(next, me.accountId),
    );
  }
  ops.push(
    env.DB.prepare("INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?,?,?,?)").bind(
      me.accountId,
      next,
      now,
      held?.verified ?? 0,
    ),
  );
  await env.DB.batch(ops);
  return json(
    { ok: true, callsign: next, verified: !!held?.verified },
    { headers: { "set-cookie": await issueSessionCookie(next, env) } },
  );
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
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? SESSION_TTL_DAYS_DEFAULT) || SESSION_TTL_DAYS_DEFAULT;
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlDays * 86_400}`;
}

/** GET /auth/session — "who am I": the signed-in callsign + verification + email, or null. */
export async function handleSession(req: Request, env: Env): Promise<Response> {
  const callsign = await sessionCallsign(req, env);
  if (!callsign) return json({ callsign: null });
  const acct = await env.DB.prepare("SELECT verified, email FROM accounts WHERE callsign = ?")
    .bind(callsign)
    .first<{ verified: number; email: string | null }>();
  return json({ callsign, verified: !!acct?.verified, email: acct?.email ?? null });
}

/** POST /auth/logout — clear the session cookie. */
export async function handleLogout(): Promise<Response> {
  return json(
    { ok: true },
    { headers: { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } },
  );
}

// --- minimal signed session (HMAC). Replace with your preferred session strategy. ---

/** Constant-time string compare — a `===` on a secret leaks how many leading
 *  characters matched via response timing. XOR-accumulate over the LONGER length so neither
 *  the mismatch position nor (beyond an unavoidable coarse bound) the length short-circuits. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** The one gate for shared-secret headers (x-ingest-secret, x-fed-secret, x-relay-secret):
 *  fail closed on an unset/empty expected secret, compare in constant time otherwise. */
export function secretOk(given: string | null | undefined, expected: string | undefined): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  return timingSafeEqual(given ?? "", expected);
}

/** A session signed with a known/default secret is forgeable for ANY callsign —
 *  including ADMIN_CALLSIGNS. Never mint or honor sessions on such a key. */
export function weakSecret(s: string | undefined): boolean {
  return !s || s === "change-me";
}
/** The session-signing secret: a dedicated SESSION_SECRET when configured, else derived from
 *  INGEST_SECRET (single-operator self-host convenience). Weak ⇒ null: no sessions at all. */
function sessionSecret(env: Env): string | null {
  if (env.SESSION_SECRET) return weakSecret(env.SESSION_SECRET) ? null : env.SESSION_SECRET;
  return weakSecret(env.INGEST_SECRET) ? null : env.INGEST_SECRET + ":session";
}
async function key(env: Env): Promise<CryptoKey | null> {
  const raw = sessionSecret(env);
  if (raw == null) return null;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(raw), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
async function signSession(callsign: string, env: Env): Promise<string> {
  const k = await key(env);
  if (!k)
    throw new Error(
      "refusing to mint a session: INGEST_SECRET is unset or the 'change-me' default — set a strong secret (or a dedicated SESSION_SECRET)",
    );
  const payload = `${callsign}.${Date.now()}`;
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload));
  return `${btoa(payload)}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}
/** The cookie's Max-Age is only a client hint — enforce the lifetime server-side too,
 *  or a captured token stays valid until the signing secret rotates. Tunable via SESSION_TTL_DAYS;
 *  SESSION_EPOCH (unix seconds) lets an operator revoke every session minted before a point in
 *  time without rotating secrets (e.g. after a device loss report). */
export const SESSION_TTL_DAYS_DEFAULT = 30;
export function sessionExpired(mintedAtMs: number, env: Env, nowMs: number): boolean {
  if (!Number.isFinite(mintedAtMs)) return true;
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? SESSION_TTL_DAYS_DEFAULT) || SESSION_TTL_DAYS_DEFAULT;
  const age = nowMs - mintedAtMs;
  if (age > ttlDays * 86_400_000) return true; // past its lifetime
  if (age < -300_000) return true; // minted in the future (forged timestamp)
  const epoch = Number(env.SESSION_EPOCH ?? 0);
  return epoch > 0 && mintedAtMs < epoch * 1000; // operator-revoked generation
}
async function verifySession(token: string, env: Env): Promise<string | null> {
  try {
    const k = await key(env);
    if (!k) return null; // default secret ⇒ no session is ever valid
    const [p, s] = token.split(".");
    const payload = atob(p!);
    const sig = Uint8Array.from(atob(s!), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", k, sig, new TextEncoder().encode(payload));
    if (!ok) return null;
    const [callsign, minted] = payload.split(".");
    if (sessionExpired(Number(minted), env, Date.now())) return null;
    return callsign!;
  } catch {
    return null;
  }
}
