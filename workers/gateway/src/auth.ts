// SPDX-License-Identifier: AGPL-3.0-or-later
import { boxPrincipal } from "./boxprincipal.js";
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import type { SqlStatement } from "./runtime.js";
import { json } from "./http.js";
import { randomChallenge, verifyRegistration, verifyAssertion } from "./webauthn.js";
import { bytesToB64, bytesToB64url, b64urlToBytes } from "./util/b64.js";
import { rateLimitedDurable, clientIp } from "./corroborate_privacy.js";
import { licenceFor } from "./licence.js";
import { isCallsignVerified, verificationsOf } from "./callsign.js";
import { baseCall } from "@aprscaching/aprs";
import { FALLBACK_SERVICE_CALL } from "./servicecall.js";
import { normalEmail, sendEmailConfirmation } from "./email.js";
import { mailTransport } from "./mail.js";
import { adminCalls } from "./admin.js";
import { mainOrigin, passkeyOrigins, requestOrigin } from "./origins.js";

/**
 * Identity = callsign + passkey (WebAuthn), with email magic-link recovery (email.ts). Passkey
 * ceremonies are verified in webauthn.ts (Web Crypto, runtime-agnostic). A session is a signed (HMAC,
 * keyed by SESSION_SECRET) cookie naming the durable account, its session generation, the active call, the
 * address of the instance it was issued on and its scope; it is honoured only on that address, while that
 * account still exists, holds the call, and has not moved on to a newer generation.
 */

const SESSION_COOKIE = "acs";
const CHALLENGE_TTL = 300;

/** The expected WebAuthn origins/rpId MUST come from configuration. Falling back to the
 *  request's Origin header validates the binding against an attacker-supplied value — any site could
 *  satisfy the ceremony. The origins are APP_URL and every https EXTRA_ORIGINS entry, all under the one
 *  rpId (origins.ts). Unconfigured ⇒ null, and the passkey endpoints refuse (fail closed); the email
 *  magic-link path is unaffected. */
function authOrigins(env: Env): string[] | null {
  const origins = mainOrigin(env) ? passkeyOrigins(env) : [];
  return origins.length ? origins : null;
}
function rpId(env: Env): string | null {
  if (env.RP_ID) return env.RP_ID;
  try {
    return env.APP_URL ? new URL(env.APP_URL).hostname : null;
  } catch {
    return null;
  }
}

/**
 * The sign-in paths this instance offers. Passkeys need a secure-context address (https, or http on the
 * loopback host): APP_URL or one in EXTRA_ORIGINS; email needs a mail transport (mail.ts); the operator-issued link needs
 * OPERATOR_SECRET. An instance with neither passkeys nor email is off-grid: the operator's link is then
 * the only way in, and it serves every account (see handleOperatorLink).
 */
export function signInPaths(env: Env): { passkeys: boolean; email: boolean; operatorLink: boolean } {
  const passkeys = authOrigins(env) !== null;
  return {
    passkeys,
    email: mailTransport(env) !== null,
    operatorLink: !weakSecret(env.OPERATOR_SECRET),
  };
}

/** A browser drops a `Secure` cookie set over plain http, so a session issued on an http address of the
 *  instance (an off-grid LAN box, a HAMNET name) goes without the flag; one issued over https keeps it. The
 *  cookie is host-only (no Domain), so each address holds its own session. */
function cookieFlags(req: Request, env: Env): string {
  return requestOrigin(req, env).startsWith("http:")
    ? "HttpOnly; SameSite=Lax; Path=/"
    : "HttpOnly; Secure; SameSite=Lax; Path=/";
}

function webauthnUnconfigured(): Response {
  return json(
    { error: "passkeys require APP_URL (and optionally RP_ID) to be configured on this instance" },
    { status: 503 },
  );
}
/** Stash a ceremony under its own random challenge, which is the row's id: the finish names it. */
async function storeChallenge(env: Env, cs: string, kind: string, challenge: string, value: string): Promise<void> {
  const now = nowS();
  await env.DB.batch([
    // reap expired ceremonies while we're here — abandoned begins must not accumulate
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO auth_challenges (id, callsign, kind, value, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      challenge,
      cs,
      kind,
      value,
      now + CHALLENGE_TTL,
    ),
  ]);
}

/** The challenge a ceremony's clientDataJSON (base64url) answers, or null when it carries none. */
function answeredChallenge(clientDataJSON: unknown): string | null {
  try {
    const cd = JSON.parse(new TextDecoder().decode(b64urlToBytes(String(clientDataJSON)))) as { challenge?: unknown };
    return typeof cd.challenge === "string" && cd.challenge !== "" ? cd.challenge : null;
  } catch {
    return null;
  }
}

/**
 * Consume the ceremony a finish answers: the unexpired challenge named in its clientDataJSON, begun for
 * this call and kind. One atomic delete spends it, so it completes at most one finish, and ceremonies
 * that others begin for the same call never displace it.
 */
async function takeChallenge(env: Env, cs: string, kind: string, clientDataJSON: unknown): Promise<string | null> {
  const challenge = answeredChallenge(clientDataJSON);
  if (!challenge) return null;
  const row = await env.DB.prepare(
    "DELETE FROM auth_challenges WHERE id=? AND callsign=? AND kind=? AND expires_at>? RETURNING value",
  )
    .bind(challenge, cs, kind, nowS())
    .first<{ value: string }>();
  return row?.value ?? null;
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

/** The marker an account's content shows under once the account holds no call: its last call moved to the
 *  call's licensee (claims.ts). Each account gets its own suffix (`FORMER#…`), which is also its active-call
 *  placeholder, so the content follows the account when it takes a call on again. */
export const FORMER = "FORMER";
export const formerMarker = (): string =>
  `${FORMER}#${[...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
export const isFormerMarker = (c: string | null | undefined): boolean =>
  (c ?? "").toUpperCase().startsWith(`${FORMER}#`);

/** A call as served to readers and peers: any withdrawn marker reads as plain `WITHDRAWN`, and any former-holder
 *  marker as plain `FORMER`, so a per-account suffix never links one person's rows outside this instance. */
export const displayCall = (c: string): string => (isWithdrawnCall(c) ? WITHDRAWN : isFormerMarker(c) ? FORMER : c);

/** Base calls that name this instance or a marker, never a person: the erased-owner and former-holder markers
 *  and the service call of an instance with no sysop. A sysop's own service call is their licence. */
const RESERVED_CALLS = new Set([WITHDRAWN, FORMER, FALLBACK_SERVICE_CALL]);

/** Is `cs` (or its base call) listed in ADMIN_CALLSIGNS? Such a call is registered only through the operator's
 *  link or a proof of control, never by an unproven sign-up. */
export const isAdminCall = (env: Env, cs: string): boolean =>
  [...adminCalls(env)].some((c) => baseCall(c) === baseCall(cs));
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

/** Why a call cannot be taken on without proof of control: its code (`reason` in a 409 answer) and the words. */
interface CallRefusal {
  reason: "invalid" | "reserved" | "suspended" | "held" | "held_unverified" | "operator_call";
  error: string;
}

/** The refusal of a call some account holds: the holder signs in, or — while the holder has not proven control
 *  and the call is not the operator's — the licensee takes it over by proving control (claims.ts). */
async function heldRefusal(env: Env, base: string): Promise<CallRefusal> {
  if (!isAdminCall(env, base) && !(await isCallsignVerified(env, base)))
    return {
      reason: "held_unverified",
      error:
        "an account that has not proven control holds this callsign — sign in, or prove you control it to take it over",
    };
  return { reason: "held", error: "callsign already claimed — sign in instead" };
}

/**
 * Why `cs` cannot be taken on without proof of control, or null when it can: a malformed or reserved call, a
 * base call some account already holds (an SSID never opens a second account on someone else's licence), or an
 * ADMIN_CALLSIGNS call, which only the operator's link (`operatorLink`) or a proof of control registers.
 */
export async function callRefusal(
  env: Env,
  cs: string,
  o: { operatorLink?: boolean } = {},
): Promise<CallRefusal | null> {
  if (!REGISTRABLE_CALL.test(cs)) return { reason: "invalid", error: "invalid callsign" };
  const base = baseCall(cs);
  if (isReservedCall(base)) return { reason: "reserved", error: "that callsign is reserved" };
  const suspended = await callsignSuspension(env, base);
  if (suspended) return { reason: "suspended", error: suspendedCallText(suspended) };
  if (await baseHolder(env, base)) return heldRefusal(env, base);
  if (isAdminCall(env, base) && !o.operatorLink)
    return {
      reason: "operator_call",
      error: "this is the instance operator's callsign — sign in with the operator's link, or prove you control it",
    };
  return null;
}

/** Why `cs` cannot open a new account ({@link callRefusal} in words), or null when it can. */
export async function unclaimableReason(
  env: Env,
  cs: string,
  o: { operatorLink?: boolean } = {},
): Promise<string | null> {
  return (await callRefusal(env, cs, o))?.error ?? null;
}

/** The 4xx answer for a refusal: 400 for a malformed call, 409 otherwise, with its code as `reason`. */
export const refusalResponse = (r: CallRefusal): Response =>
  json(
    { error: r.error, reason: r.reason },
    { status: r.reason === "invalid" ? 400 : r.reason === "suspended" ? 403 : 409 },
  );

/**
 * The suspension a base call is under after its account was erased, or null: the minimal record erasure keeps
 * (category and end, nothing else) so the call cannot come back under a new account until it ends.
 */
export async function callsignSuspension(
  env: Env,
  base: string,
): Promise<{ category: string; until: number | null; at: number } | null> {
  const s = await env.DB.prepare("SELECT category, until, at FROM callsign_suspensions WHERE callsign=?")
    .bind(base)
    .first<{ category: string; until: number | null; at: number }>();
  return s && suspensionHolds(s.at, s.until) ? s : null;
}

/** The refusal a suspended call answers with: the suspension, its end and its category. */
export const suspendedCallText = (s: { category: string; until: number | null }): string =>
  `this callsign is suspended on this instance${
    s.until ? ` until ${new Date(s.until * 1000).toISOString().slice(0, 10)}` : ""
  }: ${s.category}`;

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
/**
 * The passkey sign-in steps and the claim probe are throttled per client address only. A per-call budget
 * would let requests from a pool of addresses naming someone's call spend it and keep that person out,
 * while it adds nothing against guessing: a passkey assertion is a signature, and each ceremony answers
 * only its own challenge.
 */
const PASSKEY_LOGIN_LIMITS = { perIp: 30, perIdentity: 0, windowMs: 60_000 };

/** The account a sign-in names: the holder of the call's base call, whichever held call (or SSID of one) is
 *  typed. The session carries the typed call when it is the active call or an SSID of it, and the account's
 *  active call otherwise, so signing in never changes which call the account operates. */
async function signInAccount(env: Env, cs: string): Promise<{ accountId: string; callsign: string } | null> {
  if (!REGISTRABLE_CALL.test(cs)) return null;
  const holder = await baseHolder(env, baseCall(cs));
  if (!holder) return null;
  const row = await env.DB.prepare("SELECT callsign FROM accounts WHERE account_id=?")
    .bind(holder)
    .first<{ callsign: string }>();
  if (!row) return null;
  return { accountId: holder, callsign: baseCall(row.callsign) === baseCall(cs) ? cs : row.callsign };
}

/** POST /auth/claim {callsign} — probe whether a callsign exists / has a passkey (no side effects). */
export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = String(callsign ?? "")
    .toUpperCase()
    .trim();
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const limited = await authThrottled(env, req, "claim", "", { perIp: 30, perIdentity: 0, windowMs: 60_000 });
  if (limited) return limited;
  const acct = await signInAccount(env, cs);
  const hasPasskey = acct
    ? await env.DB.prepare("SELECT 1 FROM credentials WHERE account_id=? LIMIT 1").bind(acct.accountId).first()
    : null;
  // whether a licensee who is not this account's owner can take the call over, or must register it by proof
  const refusal = REGISTRABLE_CALL.test(cs) ? await callRefusal(env, cs) : null;
  return json({
    callsign: cs,
    exists: !!acct,
    hasPasskey: !!hasPasskey,
    claimable: refusal?.reason === "held_unverified",
    operatorCall: refusal?.reason === "operator_call",
    licence: await licenceFor(env, cs),
  });
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
  let accountId: string;
  let pendingNew = false;
  // the account that holds this call, whether it is the account's active call or another it holds
  const holder = REGISTRABLE_CALL.test(cs) ? await baseHolder(env, baseCall(cs)) : null;
  if (holder) {
    // Another passkey for a held call is added only from a session of the account that holds it: a new
    // device of the same ham, whichever of the account's calls the session is using.
    const me = await sessionIdentity(req, env);
    if (!me || me.accountId !== holder) return refusalResponse(await heldRefusal(env, baseCall(cs)));
    accountId = holder;
  } else {
    const refused = await callRefusal(env, cs);
    if (refused) return refusalResponse(refused);
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
    challenge,
    JSON.stringify({ c: challenge, ...(pendingNew ? { a: accountId, e: normalEmail(email) } : {}) }),
  );
  const excl = await env.DB.prepare("SELECT id FROM credentials WHERE account_id=?")
    .bind(accountId)
    .all<{ id: string }>();
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
  if (!credential?.response?.attestationObject) return json({ error: "no pending registration" }, { status: 400 });
  const stashed = await takeChallenge(env, cs, "webauthn_reg", credential.response.clientDataJSON);
  if (!stashed) return json({ error: "no pending registration" }, { status: 400 });
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
    // A credential id names one passkey of one account: a registration that repeats a registered id is
    // refused, never rebound (WebAuthn §7.1: the credentialId must not yet be registered for any user).
    const taken = async () =>
      !!(await env.DB.prepare("SELECT 1 FROM credentials WHERE id=?").bind(r.credentialId).first());
    if (await taken()) return json({ error: "this passkey is already registered" }, { status: 409 });
    const now = nowS();
    const transports = JSON.stringify(credential.response.transports ?? []);
    const insertCred = (account: string) =>
      env.DB.prepare(
        "INSERT INTO credentials (id, callsign, account_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(r.credentialId, cs, account, r.coseKey, r.signCount, transports, now);
    let confirmation: Awaited<ReturnType<typeof sendEmailConfirmation>> | null = null;
    if (pending.a) {
      // Passkey proven — NOW create the account. If the callsign was claimed through another path
      // during the ceremony window, refuse rather than bind this passkey to someone else's account.
      const raced = await callRefusal(env, cs);
      if (raced) return refusalResponse(raced);
      try {
        // seed the held-callsign set with this call as the account's primary; the unique base-call index
        // makes a concurrent claim (and the credential's primary key a concurrent registration of the
        // same passkey) fail the whole batch. A given address waits for confirmation.
        await env.DB.batch([
          ...holdCall(env, pending.a, baseCall(cs), true, now),
          env.DB.prepare(
            "INSERT INTO accounts (callsign, account_id, pending_email, created_at) VALUES (?, ?, ?, ?)",
          ).bind(cs, pending.a, pending.e ?? null, now),
          insertCred(pending.a),
        ]);
      } catch {
        if (await taken()) return json({ error: "this passkey is already registered" }, { status: 409 });
        return json({ error: "callsign already claimed — sign in instead" }, { status: 409 });
      }
      accountId = pending.a;
      if (pending.e) confirmation = await sendEmailConfirmation(req, env, pending.e, cs);
    } else {
      accountId = await baseHolder(env, baseCall(cs));
      if (!accountId) return json({ error: "no pending registration" }, { status: 400 });
      try {
        await insertCred(accountId).run();
      } catch {
        return json({ error: "this passkey is already registered" }, { status: 409 });
      }
    }
    // a passkey added to an existing account keeps the session on the call it was using
    const me = pending.a ? null : await sessionIdentity(req, env);
    const sessionCall = me && me.accountId === accountId ? me.callsign : cs;
    return json(
      {
        ok: true,
        callsign: sessionCall,
        licence: await licenceFor(env, sessionCall),
        ...(confirmation ? { emailPending: true, ...confirmation } : {}),
      },
      { headers: { "set-cookie": await issueSessionCookie(req, env, accountId, sessionCall) } },
    );
  } catch (e) {
    if (e instanceof SessionUnavailable) return sessionUnavailable();
    if (e instanceof AccountSuspended) return suspendedResponse(e);
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
  const limited = await authThrottled(env, req, "pklogin-begin", "", PASSKEY_LOGIN_LIMITS);
  if (limited) return limited;
  const acct = await signInAccount(env, cs);
  const creds = acct
    ? await env.DB.prepare("SELECT id FROM credentials WHERE account_id=?").bind(acct.accountId).all<{ id: string }>()
    : null;
  if (!creds?.results?.length) return json({ error: "no passkey for this callsign" }, { status: 404 });
  const challenge = randomChallenge();
  await storeChallenge(env, cs, "webauthn_login", challenge, challenge);
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
  const limited = await authThrottled(env, req, "pklogin-finish", "", PASSKEY_LOGIN_LIMITS);
  if (limited) return limited;
  if (!credential?.id || !credential?.response?.signature) return json({ error: "no pending login" }, { status: 400 });
  const challenge = await takeChallenge(env, cs, "webauthn_login", credential.response.clientDataJSON);
  if (!challenge) return json({ error: "no pending login" }, { status: 400 });
  const acct = await signInAccount(env, cs);
  if (!acct) return json({ error: "login failed: no account holds this callsign" }, { status: 400 });
  const cred = await env.DB.prepare("SELECT public_key, counter FROM credentials WHERE id=? AND account_id=?")
    .bind(credential.id, acct.accountId)
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
    return json(
      { ok: true, callsign: acct.callsign },
      { headers: { "set-cookie": await issueSessionCookie(req, env, acct.accountId, acct.callsign) } },
    );
  } catch (e) {
    if (e instanceof SessionUnavailable) return sessionUnavailable();
    if (e instanceof AccountSuspended) return suspendedResponse(e);
    return json({ error: "login failed: " + (e as Error).message }, { status: 400 });
  }
}

/** The signed-in person as the session proves them: the durable account, the active call and its base, and the
 *  address of this instance the session was issued on. */
interface SessionIdentity {
  accountId: string;
  callsign: string;
  base: string;
  origin: string;
}

/**
 * Resolve the signed-in session — the single canonical resolver every authorisation decision uses. The
 * cookie names an account, a session generation and a call; it resolves only while that account still
 * exists at that generation and holds the call's base in `account_callsigns`. An erased
 * account, a later holder of the same call, a sign-out-everywhere, and a callsign change all leave an
 * older cookie resolving to nobody.
 */
export async function sessionIdentity(req: Request, env: Env): Promise<SessionIdentity | null> {
  const claims = await currentSession(req, env, "full");
  if (!claims) return null;
  const base = baseCall(claims.callsign);
  if ((await baseHolder(env, base)) !== claims.accountId) return null;
  return { accountId: claims.accountId, callsign: claims.callsign, base, origin: claims.origin };
}

/**
 * The session of scope `scope` the request's cookie carries, while its account exists at the session's
 * generation and is not suspended: a suspended account acts as nobody, with no write and no transmission
 * through this instance while the suspension holds. A `data` session is the exception: it reaches only the
 * account's data export and erasure, which a suspension never closes.
 */
async function currentSession(req: Request, env: Env, scope: SessionScope): Promise<SessionClaims | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)acs=([^;]+)/.exec(cookie);
  if (!m) return null;
  const claims = await verifySession(m[1]!, req, env);
  if (!claims || claims.scope !== scope) return null;
  const row = await env.DB.prepare("SELECT session_gen FROM accounts WHERE account_id=?")
    .bind(claims.accountId)
    .first<{ session_gen: number }>();
  if (!row || Number(row.session_gen) !== claims.gen) return null;
  if (scope !== "data" && (await suspensionOf(env, claims.accountId))) return null;
  return claims;
}

/**
 * The account a data-only session serves, with the call or marker its content shows under, or null. Such a session
 * is issued by email link to an account that holds no call (its last call moved to the call's licensee, claims.ts),
 * or to a suspended account, which signs in nowhere else. It lets its owner export or erase the account's data and
 * nothing else: it never passes {@link sessionIdentity}, and it ends once the account takes a call on again or its
 * suspension is lifted.
 */
export async function accountDataSession(
  req: Request,
  env: Env,
): Promise<{ accountId: string; marker: string } | null> {
  const claims = await currentSession(req, env, "data");
  if (!claims) return null;
  const row = await env.DB.prepare("SELECT callsign FROM accounts WHERE account_id=?")
    .bind(claims.accountId)
    .first<{ callsign: string }>();
  if (!row || row.callsign.toUpperCase() !== claims.callsign) return null;
  if (!isFormerMarker(row.callsign) && !(await suspensionOf(env, claims.accountId))) return null;
  return { accountId: claims.accountId, marker: row.callsign };
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

/** Why a signed-in account cannot add base call `base` it does not hold: {@link callRefusal}, worded for an
 *  account that adds a call rather than one that signs in. */
async function addRefusal(env: Env, base: string): Promise<CallRefusal | null> {
  const r = await callRefusal(env, base);
  if (r?.reason === "held") return { ...r, error: "callsign already held by another account" };
  if (r?.reason === "held_unverified")
    return {
      ...r,
      error: "an account that has not proven control holds this callsign — prove you control it to take it over",
    };
  if (r?.reason === "operator_call")
    return { ...r, error: "this is the instance operator's callsign — prove you control it to add it" };
  return r;
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
  const holder = await baseHolder(env, base);
  if (holder === me.accountId) return json({ error: "you already hold that callsign" }, { status: 409 });
  const refused = await addRefusal(env, base);
  if (refused) return refusalResponse(refused);
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
 * account's passkeys belong to the account, so they sign in from any call it holds; the session cookie
 * re-binds to the new active call and the change is recorded in callsign_history.
 */
export async function handleChangeCallsign(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const next = baseCall(String(callsign ?? ""));
  if (next.length < 3) return json({ error: "callsign required" }, { status: 400 });
  if (next === me.base) return json({ error: "that is already your active callsign" }, { status: 400 });
  // a base call held by a DIFFERENT account, and an operator call nobody holds, are off-limits
  const owner = await baseHolder(env, next);
  const refused = owner === me.accountId ? null : await addRefusal(env, next);
  if (refused) return refusalResponse(refused);
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
    { headers: { "set-cookie": await issueSessionCookie(req, env, me.accountId, next) } },
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

/** Is a suspension recorded at `at` (null: none) still in force? `until` null holds until it is lifted. */
const suspensionHolds = (at: number | null, until: number | null): boolean =>
  at != null && (until == null || until > nowS());

/** The suspension in force on an account, or null. */
export async function suspensionOf(
  env: Env,
  accountId: string,
): Promise<{ reason: string; category: string; until: number | null; at: number } | null> {
  const s = await env.DB.prepare("SELECT reason, category, until, at FROM account_suspensions WHERE account_id=?")
    .bind(accountId)
    .first<{ reason: string; category: string; until: number | null; at: number }>();
  return s && suspensionHolds(s.at, s.until) ? s : null;
}

/** Thrown when a sign-in reaches an account the sysop has suspended: no session is issued. */
export class AccountSuspended extends Error {
  constructor(readonly suspension: { reason: string; until: number | null }) {
    const until = suspension.until ? ` until ${new Date(suspension.until * 1000).toISOString().slice(0, 10)}` : "";
    super(`this account is suspended on this instance${until}: ${suspension.reason}`);
  }
}

/** The answer to a sign-in that reached a suspended account: what holds, and until when. */
export function suspendedResponse(e: AccountSuspended): Response {
  return json({ error: e.message, suspended: e.suspension }, { status: 403 });
}

/**
 * Set-Cookie header value for a session bound to `accountId` at its current generation, acting as `callsign`, on
 * the address of this instance the request came on. Every sign-in path mints its session here, so a suspended
 * account is refused in one place. A `data` session serves only the account's data export and erasure
 * ({@link accountDataSession}) and lasts an hour; a suspended account gets one, since a suspension never closes
 * the person's access to their data.
 */
export async function issueSessionCookie(
  req: Request,
  env: Env,
  accountId: string,
  callsign: string,
  scope: SessionScope = "full",
): Promise<string> {
  const row = await env.DB.prepare("SELECT session_gen FROM accounts WHERE account_id=?")
    .bind(accountId)
    .first<{ session_gen: number }>();
  if (!row) throw new Error("no such account");
  const suspended = scope === "data" ? null : await suspensionOf(env, accountId);
  if (suspended) throw new AccountSuspended(suspended);
  const token = await signSession(env, {
    accountId,
    gen: Number(row.session_gen),
    callsign: callsign.toUpperCase(),
    origin: requestOrigin(req, env),
    scope,
  });
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? SESSION_TTL_DAYS_DEFAULT) || SESSION_TTL_DAYS_DEFAULT;
  const maxAge = scope === "data" ? DATA_SESSION_TTL_SEC : ttlDays * 86_400;
  return `${SESSION_COOKIE}=${token}; ${cookieFlags(req, env)}; Max-Age=${maxAge}`;
}

/** Why a session the browser still holds no longer signs anyone in, when the person should be told. */
type SessionEnded =
  | { reason: "suspended"; until: number | null; why: string }
  | { reason: "released"; callsign: string; by: "licensee" | "sysop"; note: string | null; callless: boolean };

/**
 * Why the session cookie on `req` stopped resolving, or null when there is nothing to tell: no cookie, a forged
 * or expired one, a sign-out everywhere, an erased account. A suspension of the account, or its call moving to
 * its licensee or released by the sysop, is told, so the app can say what happened instead of dropping the
 * person on the landing page without a word. Only a cookie this instance signed is read, so a request learns
 * nothing about an account it never held a session of.
 */
async function sessionEnded(req: Request, env: Env): Promise<SessionEnded | null> {
  const m = /(?:^|;\s*)acs=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  if (!m) return null;
  const claims = await verifySession(m[1]!, req, env);
  if (!claims || claims.scope !== "full") return null;
  const acct = await env.DB.prepare("SELECT callsign FROM accounts WHERE account_id = ?")
    .bind(claims.accountId)
    .first<{ callsign: string }>();
  if (!acct) return null;
  const suspended = await suspensionOf(env, claims.accountId);
  if (suspended) return { reason: "suspended", until: suspended.until, why: suspended.reason };
  const base = baseCall(claims.callsign);
  if ((await baseHolder(env, base)) === claims.accountId) return null;
  const moved = await env.DB.prepare(
    "SELECT action, note FROM callsign_events WHERE callsign = ? AND from_account = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(base, claims.accountId)
    .first<{ action: string; note: string | null }>();
  if (!moved) return null;
  const claimed = moved.action === "claimed";
  return {
    reason: "released",
    callsign: base,
    by: claimed ? "licensee" : "sysop",
    note: claimed ? null : moved.note,
    callless: isFormerMarker(acct.callsign),
  };
}

/**
 * GET /auth/session — "who am I": the signed-in callsign + verification + confirmed email (and an address still
 * waiting for confirmation) + the account's passkey count, or null; `accountData` when the session serves only
 * the account's data, and `ended` when a session this browser held ended for a reason it is told
 * ({@link sessionEnded}).
 */
export async function handleSession(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) {
    if (await accountDataSession(req, env)) return json({ callsign: null, accountData: true });
    const ended = await sessionEnded(req, env);
    return json({ callsign: null, ...(ended ? { ended } : {}) });
  }
  const acct = await env.DB.prepare(
    "SELECT email, pending_email, (SELECT COUNT(*) FROM credentials c WHERE c.account_id = a.account_id) AS passkeys FROM accounts a WHERE account_id = ?",
  )
    .bind(me.accountId)
    .first<{ email: string | null; pending_email: string | null; passkeys: number }>();
  return json({
    callsign: me.callsign,
    verified: await isCallsignVerified(env, me.base),
    email: acct?.email ?? null,
    pendingEmail: acct?.pending_email ?? null,
    passkeys: Number(acct?.passkeys ?? 0),
  });
}

const clearCookie = (req: Request, env: Env) => `${SESSION_COOKIE}=; ${cookieFlags(req, env)}; Max-Age=0`;

/** POST /auth/logout — clear the session cookie. */
export function handleLogout(req: Request, env: Env): Response {
  return json({ ok: true }, { headers: { "set-cookie": clearCookie(req, env) } });
}

/** POST /auth/logout-all — end every session of the signed-in account, on every device. */
export async function handleLogoutAll(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  await endAllSessions(env, me.accountId);
  return json({ ok: true }, { headers: { "set-cookie": clearCookie(req, env) } });
}

/** Invalidate every outstanding session of an account by moving it to the next generation. */
async function endAllSessions(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET session_gen = session_gen + 1 WHERE account_id=?").bind(accountId).run();
}

// --- signed session (HMAC over the account, its generation, the call, the mint time, the address and the scope) ---

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

/**
 * The instance's own ingest plane: does the request carry the shared INGEST_SECRET? Whoever holds it runs
 * this instance's backend and acts for any station: logging a heard find, acting as a cache owner over APRS,
 * reading every mailbox. An enrolled box's key never passes this check.
 */
export function ingestSecretOk(req: Request, env: Env): boolean {
  return secretOk(req.headers.get("x-ingest-secret"), env.INGEST_SECRET);
}

/**
 * An ingest box delivering what it hears: the shared INGEST_SECRET, or a request an enrolled box signed with
 * its own key (verified by route() before any handler runs; boxkeys.ts). Only the delivery endpoints take it:
 * /ingest, /ingest/check, /ingest/txgate and the box's own /api/box/:id endpoints. A box may be a receiver a ham lends to an
 * instance they do not run, so its key acts for no station and no owner.
 */
export function ingestOrBoxOk(req: Request, env: Env): boolean {
  return ingestSecretOk(req, env) || boxPrincipal(req) !== null;
}

/**
 * This instance's services an ingest box runs (the APRS-IS outbox, the packet BBS mailbox, FBB forwarding, the
 * NET/ROM node mirror, White Pages, federation pages and beacons): the shared INGEST_SECRET, or an enrolled box
 * the sysop marks "Runs this instance's services" (box_keys.services, off by default). Trusting a box's
 * hearings grants none of these: a lent receiver vouches for what it hears, not for this instance's mail.
 */
export function ingestOrServiceBoxOk(req: Request, env: Env): boolean {
  return ingestSecretOk(req, env) || !!boxPrincipal(req)?.services;
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
/**
 * An HMAC (base64url) over `purpose` and `data` with the session secret, for a link that acts without a
 * session (the digest's unsubscribe link). The purpose separates it from every other signature, so no such
 * value ever passes as a session. Null when the instance has no usable session secret.
 */
export async function purposeMac(env: Env, purpose: string, data: string): Promise<string | null> {
  const k = await key(env);
  if (!k) return null;
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${purpose}\n${data}`));
  return bytesToB64url(new Uint8Array(sig));
}
/** What a session may do: everything its account may (`full`), or only export and erase the account's data. */
type SessionScope = "full" | "data";
interface SessionClaims {
  accountId: string;
  gen: number;
  callsign: string;
  /** The address of this instance the session was issued on (origins.ts); it is honoured there alone. */
  origin: string;
  scope: SessionScope;
}
const SESSION_VERSION = "v3";
/** A data-only session lasts an hour: long enough to download the export or confirm the erasure. */
const DATA_SESSION_TTL_SEC = 3600;
async function signSession(env: Env, c: SessionClaims): Promise<string> {
  const k = await key(env);
  if (!k) throw new SessionUnavailable();
  const origin = bytesToB64url(new TextEncoder().encode(c.origin));
  const payload = [SESSION_VERSION, c.accountId, c.gen, c.callsign, Date.now(), origin, c.scope].join(".");
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
/**
 * The claims of a session token presented on `req`, or null. A session is honoured only on the address of this
 * instance it was issued on: the cookie is host-only, but a browser sends it to every scheme and port of that
 * host, so a session issued over plain http (a HAMNET address, where it travels unencrypted) never passes on
 * the https address of the same host, and one issued on any other address of the instance never passes here.
 */
async function verifySession(token: string, req: Request, env: Env): Promise<SessionClaims | null> {
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
    if (parts.length !== 7 || parts[0] !== SESSION_VERSION) return null;
    const [, accountId, gen, callsign, minted, o, scope] = parts as string[];
    if (!accountId || !callsign || !gen || !o || !/^\d+$/.test(gen)) return null;
    if (scope !== "full" && scope !== "data") return null;
    if (sessionExpired(Number(minted), env, Date.now())) return null;
    if (scope === "data" && Date.now() - Number(minted) > DATA_SESSION_TTL_SEC * 1000) return null;
    const origin = new TextDecoder().decode(b64urlToBytes(o));
    if (origin !== requestOrigin(req, env)) return null;
    return { accountId, gen: Number(gen), callsign, origin, scope };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the account's passkeys (one per device)
interface PasskeyOwner {
  accountId: string;
  callsign: string;
  email: string | null;
  pendingEmail: string | null;
}
/** The signed-in account, its primary call and its email: a confirmed address, and one still waiting for
 *  confirmation (which is no way in yet). */
async function passkeyOwner(req: Request, env: Env): Promise<PasskeyOwner | null> {
  const me = await sessionIdentity(req, env);
  if (!me) return null;
  return env.DB.prepare(
    `SELECT a.account_id AS accountId, ac.callsign AS callsign, a.email AS email, a.pending_email AS pendingEmail
       FROM account_callsigns ac JOIN accounts a ON a.account_id = ac.account_id
      WHERE ac.account_id=? AND ac.is_primary=1`,
  )
    .bind(me.accountId)
    .first<PasskeyOwner>();
}

/** GET /auth/passkeys — the signed-in account's passkeys: when each was added and how its device connects. */
export async function handleListPasskeys(req: Request, env: Env): Promise<Response> {
  const owner = await passkeyOwner(req, env);
  if (!owner) return json({ error: "sign in to see your passkeys" }, { status: 401 });
  const rows = (
    await env.DB.prepare("SELECT id, transports, created_at FROM credentials WHERE account_id=? ORDER BY created_at")
      .bind(owner.accountId)
      .all<{ id: string; transports: string | null; created_at: number }>()
  ).results;
  return json({
    callsign: owner.callsign,
    hasEmail: !!owner.email,
    emailPending: !owner.email && !!owner.pendingEmail,
    passkeys: rows.map((r) => {
      let transports: string[] = [];
      try {
        transports = JSON.parse(r.transports ?? "[]") as string[];
      } catch {
        /* an unreadable list is shown as unknown */
      }
      return { id: r.id, createdAt: r.created_at, transports };
    }),
  });
}

/**
 * DELETE /auth/passkeys/:id — remove one of the account's passkeys, such as a lost phone's. The last passkey of an
 * account without a confirmed email stays: removing it would leave no way to sign in.
 */
export async function handleRemovePasskey(req: Request, env: Env, id: string): Promise<Response> {
  const owner = await passkeyOwner(req, env);
  if (!owner) return json({ error: "sign in to remove a passkey" }, { status: 401 });
  const all = (
    await env.DB.prepare("SELECT id FROM credentials WHERE account_id=?").bind(owner.accountId).all<{ id: string }>()
  ).results;
  if (!all.some((c) => c.id === id)) return json({ error: "no such passkey" }, { status: 404 });
  if (all.length === 1 && !owner.email)
    return json(
      {
        error: owner.pendingEmail
          ? "this is your only way to sign in: confirm your email address or add another passkey first"
          : "this is your only way to sign in: add an email address or another passkey first",
      },
      { status: 409 },
    );
  await env.DB.prepare("DELETE FROM credentials WHERE id=? AND account_id=?").bind(id, owner.accountId).run();
  return json({ ok: true, remaining: all.length - 1 });
}
