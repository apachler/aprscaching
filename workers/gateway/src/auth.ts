// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import type { SqlStatement } from "./runtime.js";
import { json } from "./app.js";
import { randomChallenge, verifyRegistration, verifyAssertion } from "./webauthn.js";
import { bytesToB64, bytesToB64url, b64urlToBytes } from "./util/b64.js";
import { rateLimitedDurable, clientIp } from "./corroborate_privacy.js";
import { licenceFor } from "./licence.js";
import { isCallsignVerified, verificationsOf } from "./callsign.js";
import { baseCall } from "@aprscaching/aprs";

/**
 * Identity = callsign + passkey (WebAuthn), with email magic-link recovery (email.ts). Passkey
 * ceremonies are verified in webauthn.ts (Web Crypto, runtime-agnostic). A session is a signed (HMAC,
 * keyed by SESSION_SECRET) cookie naming the durable account, its session generation and the active
 * call; it is honoured only while that account still exists, holds the call, and has not moved on to a
 * newer generation.
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
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function appUrl(env: Env): URL | null {
  try {
    return env.APP_URL ? new URL(env.APP_URL) : null;
  } catch {
    return null;
  }
}

/**
 * The sign-in paths this instance offers. Passkeys need a secure-context origin (https, or http on the
 * loopback host) named by APP_URL; email needs a configured provider; the operator-issued link needs
 * OPERATOR_SECRET. An instance with neither passkeys nor email is off-grid: the operator's link is then
 * the only way in, and it serves every account (see handleOperatorLink).
 */
export function signInPaths(env: Env): { passkeys: boolean; email: boolean; operatorLink: boolean } {
  const u = appUrl(env);
  const passkeys = !!u && (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)));
  return {
    passkeys,
    email: !!env.EMAIL_FROM && !!env.EMAIL_API_KEY,
    operatorLink: !weakSecret(env.OPERATOR_SECRET),
  };
}

/** A browser drops a `Secure` cookie set over plain http, so an instance whose declared origin is http
 *  (an off-grid LAN box) issues its session cookie without the flag; every other instance keeps it. */
function cookieFlags(env: Env): string {
  return appUrl(env)?.protocol === "http:"
    ? "HttpOnly; SameSite=Lax; Path=/"
    : "HttpOnly; Secure; SameSite=Lax; Path=/";
}

function webauthnUnconfigured(): Response {
  return json(
    { error: "passkeys require APP_URL (and optionally RP_ID) to be configured on this instance" },
    { status: 503 },
  );
}
async function storeChallenge(env: Env, cs: string, kind: string, value: string): Promise<void> {
  const now = nowS();
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
    .bind(cs, kind, nowS())
    .first<{ id: string; value: string }>();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM auth_challenges WHERE id=?").bind(row.id).run();
  return row.value;
}

/** A registrable call: a 3–9 character base of letters and digits with an optional 1–2 character SSID.
 *  Anything else — including the `#` that marks an erased identity — can never name an account. */
const REGISTRABLE_CALL = /^[A-Z0-9]{3,9}(-[A-Z0-9]{1,2})?$/;

/** The owner/logger marker an erased identity is rewritten to. Each erasure gets its own suffix
 *  (`WITHDRAWN#…`) so two erased people's rows never collide on a per-caller unique index. */
export const WITHDRAWN = "WITHDRAWN";
export const isWithdrawnCall = (c: string | null | undefined): boolean => {
  const u = (c ?? "").toUpperCase();
  return u === WITHDRAWN || u.startsWith(`${WITHDRAWN}#`);
};

/** A call as served to readers and peers: any withdrawn marker reads as plain `WITHDRAWN`, so the
 *  per-erasure suffix never links an erased person's rows outside this instance. */
export const displayCall = (c: string): string => (isWithdrawnCall(c) ? WITHDRAWN : c);

/** Base calls that name this instance or an erased identity, never a person: the erased-owner marker
 *  and the default service call that takes radio commands and sends BBS mail. */
const RESERVED_CALLS = new Set([WITHDRAWN, "APRSCG"]);
const isReservedCall = (c: string): boolean => RESERVED_CALLS.has(baseCall(c));

/** The account holding a base call. `account_callsigns` is the one record of who holds a licence:
 *  every account holds the base of its active call there, and a base call has at most one holder. */
export async function baseHolder(env: Env, base: string): Promise<string | null> {
  const held = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
    .bind(base)
    .first<{ account_id: string }>();
  return held?.account_id ?? null;
}

/**
 * The statements that make `accountId` the holder of `base`, for a batch that creates or extends an
 * account. The unique index on the held call fails the whole batch when another account holds it. A
 * claim starts unverified: a verification recorded while nobody held the call was made for someone
 * else (or for nobody), so it is cleared — never for a call some account still holds.
 */
export function holdCall(env: Env, accountId: string, base: string, primary: boolean, at: number): SqlStatement[] {
  return [
    env.DB.prepare(
      "DELETE FROM callsign_verifications WHERE callsign=? AND NOT EXISTS (SELECT 1 FROM account_callsigns WHERE callsign=?)",
    ).bind(base, base),
    env.DB.prepare("INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES (?,?,?,?)").bind(
      accountId,
      base,
      primary ? 1 : 0,
      at,
    ),
  ];
}

/** Can `cs` ever name an account: a well-formed call whose base is not reserved for this instance? */
export const isRegistrableCall = (cs: string): boolean => REGISTRABLE_CALL.test(cs) && !isReservedCall(cs);

/** Why `cs` cannot open a new account, or null when it can: a malformed or reserved call, or a base
 *  call some account already holds (an SSID never opens a second account on someone else's licence). */
export async function unclaimableReason(env: Env, cs: string): Promise<string | null> {
  if (!REGISTRABLE_CALL.test(cs)) return "invalid callsign";
  const base = baseCall(cs);
  if (isReservedCall(base)) return "that callsign is reserved";
  if (await baseHolder(env, base)) return "callsign already claimed — sign in instead";
  return null;
}

/** Does this account hold the base call of `cs`? Keys and calls bind only to a licence the account holds. */
export async function accountHoldsCall(env: Env, accountId: string, cs: string): Promise<boolean> {
  return (await baseHolder(env, baseCall(cs))) === accountId;
}

/**
 * Throttle a sign-in or verification step per client address and per targeted identity (an email or
 * callsign), so neither one address nor a pool of addresses can hammer one account. Returns the 429 to
 * send, or null to proceed.
 */
export async function authThrottled(
  env: Env,
  req: Request,
  step: string,
  identity: string,
  limits: { perIp: number; perIdentity: number; windowMs: number },
): Promise<Response | null> {
  const t = Date.now();
  const ipHit = await rateLimitedDurable(env, `${step}:ip:${clientIp(req, env)}`, t, limits.perIp, limits.windowMs);
  const idHit =
    identity !== "" &&
    (await rateLimitedDurable(env, `${step}:id:${identity}`, t, limits.perIdentity, limits.windowMs));
  return ipHit || idHit ? json({ error: "rate limited — try again later" }, { status: 429 }) : null;
}
const PASSKEY_LOGIN_LIMITS = { perIp: 30, perIdentity: 10, windowMs: 60_000 };

/** POST /auth/claim {callsign} — probe whether a callsign exists / has a passkey (no side effects). */
export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const limited = await authThrottled(env, req, "claim", cs, { perIp: 30, perIdentity: 20, windowMs: 60_000 });
  if (limited) return limited;
  const existing = await env.DB.prepare("SELECT callsign FROM accounts WHERE callsign=?").bind(cs).first();
  const hasPasskey = existing
    ? await env.DB.prepare("SELECT 1 FROM credentials WHERE callsign=? LIMIT 1").bind(cs).first()
    : null;
  return json({ callsign: cs, exists: !!existing, hasPasskey: !!hasPasskey, licence: await licenceFor(env, cs) });
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
    const me = await sessionIdentity(req, env);
    if (!me || me.accountId !== existing.account_id || me.callsign !== cs)
      return json({ error: "callsign already claimed — sign in instead" }, { status: 409 });
    accountId = existing.account_id;
  } else {
    const refused = await unclaimableReason(env, cs);
    if (refused) return json({ error: refused }, { status: refused === "invalid callsign" ? 400 : 409 });
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
  if (!sessionsEnabled(env)) return sessionUnavailable();
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
  let accountId: string | null;
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
      const now = nowS();
      const raced = await unclaimableReason(env, cs);
      if (raced) return json({ error: raced }, { status: 409 });
      try {
        // seed the held-callsign set with this call as the account's primary (the passkey binds here);
        // the unique base-call index makes a concurrent claim fail the whole batch
        await env.DB.batch([
          ...holdCall(env, pending.a, baseCall(cs), true, now),
          env.DB.prepare("INSERT INTO accounts (callsign, account_id, email, created_at) VALUES (?, ?, ?, ?)").bind(
            cs,
            pending.a,
            pending.e ?? null,
            now,
          ),
        ]);
      } catch {
        return json({ error: "callsign already claimed — sign in instead" }, { status: 409 });
      }
      accountId = pending.a;
    } else {
      accountId = await accountIdOf(env, cs);
      if (!accountId) return json({ error: "no pending registration" }, { status: 400 });
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO credentials (id, callsign, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(r.credentialId, cs, r.coseKey, r.signCount, JSON.stringify(credential.response.transports ?? []), nowS())
      .run();
    return json(
      { ok: true, callsign: cs, licence: await licenceFor(env, cs) },
      { headers: { "set-cookie": await issueSessionCookie(env, accountId, cs) } },
    );
  } catch (e) {
    if (e instanceof SessionUnavailable) return sessionUnavailable();
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
  const limited = await authThrottled(env, req, "pklogin-begin", cs, PASSKEY_LOGIN_LIMITS);
  if (limited) return limited;
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
  if (!sessionsEnabled(env)) return sessionUnavailable();
  const { callsign, credential } = (await req.json().catch(() => ({}))) as { callsign?: string; credential?: Cred };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  const limited = await authThrottled(env, req, "pklogin-finish", cs, PASSKEY_LOGIN_LIMITS);
  if (limited) return limited;
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
    const accountId = await accountIdOf(env, cs);
    if (!accountId) return json({ error: "login failed: no account holds this callsign" }, { status: 400 });
    return json(
      { ok: true, callsign: cs },
      { headers: { "set-cookie": await issueSessionCookie(env, accountId, cs) } },
    );
  } catch (e) {
    if (e instanceof SessionUnavailable) return sessionUnavailable();
    return json({ error: "login failed: " + (e as Error).message }, { status: 400 });
  }
}

/** The signed-in person as the session proves them: the durable account, the active call and its base. */
interface SessionIdentity {
  accountId: string;
  callsign: string;
  base: string;
}

/**
 * Resolve the signed-in session — the single canonical resolver every authorisation decision uses. The
 * cookie names an account, a session generation and a call; it resolves only while that account still
 * exists at that generation and holds the call's base in `account_callsigns`. An erased
 * account, a later holder of the same call, a sign-out-everywhere, and a callsign change all leave an
 * older cookie resolving to nobody.
 */
export async function sessionIdentity(req: Request, env: Env): Promise<SessionIdentity | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)acs=([^;]+)/.exec(cookie);
  if (!m) return null;
  const claims = await verifySession(m[1]!, env);
  if (!claims) return null;
  const row = await env.DB.prepare("SELECT session_gen FROM accounts WHERE account_id=?")
    .bind(claims.accountId)
    .first<{ session_gen: number }>();
  if (!row || Number(row.session_gen) !== claims.gen) return null;
  const base = baseCall(claims.callsign);
  if ((await baseHolder(env, base)) !== claims.accountId) return null;
  return { accountId: claims.accountId, callsign: claims.callsign, base };
}

/**
 * May this request act as the owner of something owned by `ownerCall` (a cache, its stages and media, a
 * saved view)? Ownership follows the licence, not the call string: a signed-in session acts as owner
 * when its account holds the owner call's base call, whichever of its calls it is operating. Without a
 * session only the ingest plane acts, for the exact owner call it names (`claimed`) — the over-APRS path.
 * An erased owner's withdrawn marker has no owner.
 */
export async function mayActAsOwner(
  req: Request,
  env: Env,
  ownerCall: string,
  claimed?: string | null,
): Promise<boolean> {
  if (!ownerCall || isWithdrawnCall(ownerCall)) return false;
  const me = await sessionIdentity(req, env);
  if (me) return accountHoldsCall(env, me.accountId, ownerCall);
  return ingestSecretOk(req, env) && !!claimed && claimed.trim().toUpperCase() === ownerCall.toUpperCase();
}

/** The durable account id anchored at a call (its `accounts` row). */
async function accountIdOf(env: Env, cs: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?")
    .bind(cs)
    .first<{ account_id: string | null }>();
  return row?.account_id ?? null;
}

/**
 * GET /auth/callsigns — the held base calls of the signed-in account, with verification state and
 * which one is currently active / primary. The account (person) holds one or more base calls; the
 * passkey lives on the primary; the active call is whichever the session is bound to.
 */
export async function handleListCallsigns(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const active = me.base;
  const rows =
    (
      await env.DB.prepare(
        "SELECT callsign, is_primary FROM account_callsigns WHERE account_id=? ORDER BY is_primary DESC, added_at ASC, callsign ASC",
      )
        .bind(me.accountId)
        .all<{ callsign: string; is_primary: number }>()
    ).results ?? [];
  // `verified` is control-verification; `licence` is register validity — shown side by side, never merged
  const verified = await verificationsOf(
    env,
    rows.map((r) => r.callsign),
  );
  const licences = await Promise.all(rows.map((r) => licenceFor(env, r.callsign)));
  return json({
    active,
    callsigns: rows.map((r, i) => ({
      callsign: r.callsign,
      verified: verified.has(r.callsign),
      isPrimary: !!r.is_primary,
      active: r.callsign === active,
      licence: licences[i],
    })),
  });
}

/**
 * POST /auth/callsigns {callsign} — add another base call to the signed-in account (unverified;
 * verify it by an on-air VERIFY challenge). Does NOT change the active call. A base call can be held by
 * only one account, so a call already on another account is rejected.
 */
export async function handleAddCallsign(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const base = baseCall(String(callsign ?? ""));
  if (base.length < 3) return json({ error: "callsign required" }, { status: 400 });
  if (!REGISTRABLE_CALL.test(base)) return json({ error: "invalid callsign" }, { status: 400 });
  if (isReservedCall(base)) return json({ error: "that callsign is reserved" }, { status: 409 });
  const holder = await baseHolder(env, base);
  if (holder)
    return json(
      holder === me.accountId
        ? { error: "you already hold that callsign" }
        : { error: "callsign already held by another account" },
      { status: 409 },
    );
  try {
    await env.DB.batch(holdCall(env, me.accountId, base, false, nowS()));
  } catch {
    return json({ error: "callsign already held by another account" }, { status: 409 });
  }
  return json({ ok: true, callsign: base, verified: false, licence: await licenceFor(env, base) });
}

/**
 * POST /auth/callsign {callsign} — switch the active operating callsign of the signed-in account.
 * Switching to a base call the account ALREADY HOLDS is non-destructive: its prior verification is
 * preserved (no re-challenge). Switching to a NEW base call adds it (unverified) and switches. The
 * passkey stays on the primary call (login is unaffected); the session cookie re-binds to the new
 * active call and the change is recorded in callsign_history.
 */
export async function handleChangeCallsign(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const next = baseCall(String(callsign ?? ""));
  if (next.length < 3) return json({ error: "callsign required" }, { status: 400 });
  if (next === me.base) return json({ error: "that is already your active callsign" }, { status: 400 });
  if (!REGISTRABLE_CALL.test(next)) return json({ error: "invalid callsign" }, { status: 400 });
  if (isReservedCall(next)) return json({ error: "that callsign is reserved" }, { status: 409 });
  // a base call held by a DIFFERENT account is off-limits
  const owner = await baseHolder(env, next);
  if (owner && owner !== me.accountId)
    return json({ error: "callsign already held by another account" }, { status: 409 });
  const now = nowS();
  // a held call keeps its verification (no re-verify); a brand-new base call is held, unverified
  const verified = owner === me.accountId && (await isCallsignVerified(env, next));
  const ops = [
    ...(owner ? [] : holdCall(env, me.accountId, next, false, now)),
    env.DB.prepare("UPDATE accounts SET callsign=? WHERE account_id=?").bind(next, me.accountId),
    env.DB.prepare("INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?,?,?,?)").bind(
      me.accountId,
      next,
      now,
      verified ? 1 : 0,
    ),
    // sessions that carried the old call end; this response carries the only session for the new one
    env.DB.prepare("UPDATE accounts SET session_gen = session_gen + 1 WHERE account_id=?").bind(me.accountId),
  ];
  try {
    await env.DB.batch(ops);
  } catch {
    return json({ error: "callsign already held by another account" }, { status: 409 });
  }
  return json(
    { ok: true, callsign: next, verified },
    { headers: { "set-cookie": await issueSessionCookie(env, me.accountId, next) } },
  );
}

/** Thrown when this instance has no usable SESSION_SECRET: sign-in is closed, not silently weakened. */
class SessionUnavailable extends Error {
  constructor() {
    super(
      "sessions are disabled: set SESSION_SECRET to a strong value of its own (not INGEST_SECRET, OPERATOR_SECRET or 'change-me')",
    );
  }
}
export function sessionUnavailable(): Response {
  return json({ error: new SessionUnavailable().message }, { status: 503 });
}

/** Set-Cookie header value for a session bound to `accountId` at its current generation, acting as `callsign`. */
export async function issueSessionCookie(env: Env, accountId: string, callsign: string): Promise<string> {
  const row = await env.DB.prepare("SELECT session_gen FROM accounts WHERE account_id=?")
    .bind(accountId)
    .first<{ session_gen: number }>();
  if (!row) throw new Error("no such account");
  const token = await signSession(env, { accountId, gen: Number(row.session_gen), callsign: callsign.toUpperCase() });
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? SESSION_TTL_DAYS_DEFAULT) || SESSION_TTL_DAYS_DEFAULT;
  return `${SESSION_COOKIE}=${token}; ${cookieFlags(env)}; Max-Age=${ttlDays * 86_400}`;
}

/** GET /auth/session — "who am I": the signed-in callsign + verification + email, or null. */
export async function handleSession(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ callsign: null });
  const acct = await env.DB.prepare("SELECT email FROM accounts WHERE account_id = ?")
    .bind(me.accountId)
    .first<{ email: string | null }>();
  return json({ callsign: me.callsign, verified: await isCallsignVerified(env, me.base), email: acct?.email ?? null });
}

const clearCookie = (env: Env) => `${SESSION_COOKIE}=; ${cookieFlags(env)}; Max-Age=0`;

/** POST /auth/logout — clear the session cookie. */
export function handleLogout(env: Env): Response {
  return json({ ok: true }, { headers: { "set-cookie": clearCookie(env) } });
}

/** POST /auth/logout-all — end every session of the signed-in account, on every device. */
export async function handleLogoutAll(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  await endAllSessions(env, me.accountId);
  return json({ ok: true }, { headers: { "set-cookie": clearCookie(env) } });
}

/** Invalidate every outstanding session of an account by moving it to the next generation. */
async function endAllSessions(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET session_gen = session_gen + 1 WHERE account_id=?").bind(accountId).run();
}

// --- signed session (HMAC over the account, its generation, the call and the mint time) ---

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

/** The ingest-plane credential: does the request carry the ingest box's INGEST_SECRET? */
export function ingestSecretOk(req: Request, env: Env): boolean {
  return secretOk(req.headers.get("x-ingest-secret"), env.INGEST_SECRET);
}

/** The operator's machine credential: does the request carry OPERATOR_SECRET? Unset ⇒ never. */
export function operatorSecretOk(req: Request, env: Env): boolean {
  return secretOk(req.headers.get("x-operator-secret"), env.OPERATOR_SECRET);
}

/** A session signed with a known/default secret is forgeable for ANY callsign —
 *  including ADMIN_CALLSIGNS. Never mint or honor sessions on such a key. */
export function weakSecret(s: string | undefined): boolean {
  return !s || s === "change-me";
}
/** The session-signing secret: SESSION_SECRET, and only when it is strong and distinct from the
 *  machine credentials — whoever holds the ingest or operator secret must not be able to mint a
 *  session. Anything else ⇒ null: no sessions at all. */
/** Can this instance mint sessions at all? Sign-in endpoints check it before creating anything. */
export function sessionsEnabled(env: Env): boolean {
  return sessionSecret(env) != null;
}
function sessionSecret(env: Env): string | null {
  const s = env.SESSION_SECRET;
  if (weakSecret(s)) return null;
  if (s === env.INGEST_SECRET || s === env.OPERATOR_SECRET) return null;
  return s!;
}
async function key(env: Env): Promise<CryptoKey | null> {
  const raw = sessionSecret(env);
  if (raw == null) return null;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(raw), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
interface SessionClaims {
  accountId: string;
  gen: number;
  callsign: string;
}
const SESSION_VERSION = "v2";
async function signSession(env: Env, c: SessionClaims): Promise<string> {
  const k = await key(env);
  if (!k) throw new SessionUnavailable();
  const payload = [SESSION_VERSION, c.accountId, c.gen, c.callsign, Date.now()].join(".");
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload));
  return `${btoa(payload)}.${bytesToB64(new Uint8Array(sig))}`;
}
/** The cookie's Max-Age is only a client hint — enforce the lifetime server-side too,
 *  or a captured token stays valid until the signing secret rotates. Tunable via SESSION_TTL_DAYS;
 *  SESSION_EPOCH (unix seconds) lets an operator revoke every session minted before a point in
 *  time without rotating secrets (e.g. after a device loss report). */
const SESSION_TTL_DAYS_DEFAULT = 30;
export function sessionExpired(mintedAtMs: number, env: Env, nowMs: number): boolean {
  if (!Number.isFinite(mintedAtMs)) return true;
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? SESSION_TTL_DAYS_DEFAULT) || SESSION_TTL_DAYS_DEFAULT;
  const age = nowMs - mintedAtMs;
  if (age > ttlDays * 86_400_000) return true; // past its lifetime
  if (age < -300_000) return true; // minted in the future (forged timestamp)
  const epoch = Number(env.SESSION_EPOCH ?? 0);
  return epoch > 0 && mintedAtMs < epoch * 1000; // operator-revoked generation
}
async function verifySession(token: string, env: Env): Promise<SessionClaims | null> {
  try {
    const k = await key(env);
    if (!k) return null; // no usable secret ⇒ no session is ever valid
    const [p, sg] = token.split(".");
    const payload = atob(p!);
    const sig = b64urlToBytes(sg!);
    const ok = await crypto.subtle.verify("HMAC", k, sig, new TextEncoder().encode(payload));
    if (!ok) return null;
    // a token without an account (any other shape) is never valid
    const parts = payload.split(".");
    if (parts.length !== 5 || parts[0] !== SESSION_VERSION) return null;
    const [, accountId, gen, callsign, minted] = parts as [string, string, string, string, string];
    if (!accountId || !callsign || !/^\d+$/.test(gen)) return null;
    if (sessionExpired(Number(minted), env, Date.now())) return null;
    return { accountId, gen: Number(gen), callsign };
  } catch {
    return null;
  }
}
