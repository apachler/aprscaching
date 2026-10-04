// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * verify_challenge.ts — the challenge lifecycle shared by the callsign control-verification methods that
 * complete in the browser (`ampr_dns`, `lotw`). A challenge is bound to one base call, one method and its
 * starter: the signed-in account that holds the call, or an open claim on the call (claims.ts), whose token
 * stands in for a session. An account's challenge is good only while the account still holds the call, a
 * claim's only while the claim is open. Starting again replaces the starter's outstanding challenge;
 * completing it spends it; failed completions count toward a cap that locks it. Starts and completions are
 * rate limited per starter and per call.
 */
import { bytesToB64url } from "./util/b64.js";
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { baseCall } from "@aprscaching/aprs";
import { sessionIdentity, accountHoldsCall } from "./auth.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { claimByToken, claimOpen, claimPrincipal, type Claim } from "./claims.js";

type ChallengeMethod = "ampr_dns" | "lotw";

/** Failed completions before a challenge locks. */
const CHALLENGE_MAX_ATTEMPTS = 5;
const WINDOW_MS = 3_600_000;
/** Per hour: starts per starter and per call, and completion attempts per starter. */
const STARTS_PER_ACCOUNT = 10;
const STARTS_PER_CALL = 5;
const COMPLETES_PER_ACCOUNT = 10;

const CALL_RE = /^[A-Z0-9]{3,9}$/;

/** A random URL-safe token of `bytes` random bytes. */
export function randomToken(bytes = 16): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface Caller {
  /** The starter: the account's id, or `claim:<id>` for a claim. */
  accountId: string;
  cs: string;
  body: Record<string, unknown>;
  /** The open claim the caller proves control for, or null for a holder verifying their own call. */
  claim: Claim | null;
}

/**
 * Authenticate a start or completion: a session whose account holds the submitted base call, or the token
 * (`claim`) of an open claim on it. Returns the caller, or the error response to send.
 */
export async function holderOf(req: Request, env: Env): Promise<Caller | Response> {
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const cs = baseCall(typeof body.callsign === "string" ? body.callsign : "");
  if (!CALL_RE.test(cs)) return json({ error: "callsign required" }, { status: 400 });
  if (body.claim !== undefined) {
    const claim = await claimByToken(env, body.claim);
    if (!claim || !claimOpen(claim) || claim.callsign !== cs)
      return json({ error: "no open claim on this callsign — start the claim again" }, { status: 409 });
    return { accountId: claimPrincipal(claim.id), cs, body, claim };
  }
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to verify a callsign" }, { status: 401 });
  if (!(await accountHoldsCall(env, me.accountId, cs)))
    return json({ error: "add this callsign to your account before verifying it" }, { status: 403 });
  return { accountId: me.accountId, cs, body, claim: null };
}

/** Issue (or replace) the caller's challenge for `method`. Returns null when the start rate is exceeded. */
export async function issueChallenge(
  env: Env,
  c: Caller,
  method: ChallengeMethod,
  challenge: string,
): Promise<{ createdAt: number } | null> {
  const t = Date.now();
  // a claimant's starts and the holder's count apart, so neither can use up the other's
  const callKey = `${method}-start:${c.claim ? "claim" : "call"}:${c.cs}`;
  if (
    (await rateLimitedDurable(env, `${method}-start:acct:${c.accountId}`, t, STARTS_PER_ACCOUNT, WINDOW_MS)) ||
    (await rateLimitedDurable(env, callKey, t, STARTS_PER_CALL, WINDOW_MS))
  )
    return null;
  const createdAt = nowS();
  await env.DB.prepare(
    `INSERT INTO callsign_challenges (callsign, method, account_id, challenge, attempts, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(callsign, method, account_id) DO UPDATE SET challenge=excluded.challenge,
       attempts=0, created_at=excluded.created_at`,
  )
    .bind(c.cs, method, c.accountId, challenge, createdAt)
    .run();
  return { createdAt };
}

/** Too many completion attempts from this starter in the window. */
export async function completionLimited(env: Env, c: Caller, method: ChallengeMethod): Promise<boolean> {
  return rateLimitedDurable(env, `${method}-check:acct:${c.accountId}`, Date.now(), COMPLETES_PER_ACCOUNT, WINDOW_MS);
}

/**
 * The caller's outstanding challenge for `method`: started by this starter, within `ttlSec`, and not locked by
 * failed attempts. Null when there is none.
 */
export async function openChallenge(
  env: Env,
  c: Caller,
  method: ChallengeMethod,
  ttlSec: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT challenge, attempts, created_at FROM callsign_challenges WHERE callsign=? AND method=? AND account_id=?",
  )
    .bind(c.cs, method, c.accountId)
    .first<{ challenge: string; attempts: number; created_at: number }>();
  if (!row) return null;
  if (nowS() - row.created_at > ttlSec || row.attempts >= CHALLENGE_MAX_ATTEMPTS) return null;
  return row.challenge;
}

/** Count a failed completion against the challenge. */
export async function failAttempt(env: Env, c: Caller, method: ChallengeMethod, challenge: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE callsign_challenges SET attempts = attempts + 1 WHERE callsign=? AND method=? AND account_id=? AND challenge=?",
  )
    .bind(c.cs, method, c.accountId, challenge)
    .run();
}

/**
 * Spend the challenge before verifying, so two completions racing each other verify once. Returns false
 * when another completion already spent it.
 */
export async function spendChallenge(
  env: Env,
  c: Caller,
  method: ChallengeMethod,
  challenge: string,
): Promise<boolean> {
  const r = await env.DB.prepare(
    "DELETE FROM callsign_challenges WHERE callsign=? AND method=? AND challenge=? AND account_id=?",
  )
    .bind(c.cs, method, challenge, c.accountId)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

export const noChallenge = () =>
  json({ error: "no verification in progress for this callsign — start again" }, { status: 409 });
export const startsLimited = () => json({ error: "too many verification attempts — try again later" }, { status: 429 });
