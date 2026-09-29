// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * verify_challenge.ts — the challenge lifecycle shared by the callsign control-verification methods that
 * complete in the signed-in session (`ampr_dns`, `lotw`). A challenge is bound to one base call, one
 * method and the account that started it, and is good only while that account still holds the call.
 * Starting again replaces the outstanding challenge; completing it spends it; failed completions count
 * toward a cap that locks it. Starts and completions are rate limited per account and per call.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId, accountHoldsCall } from "./auth.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";

export type ChallengeMethod = "ampr_dns" | "lotw";

/** Failed completions before a challenge locks. */
export const CHALLENGE_MAX_ATTEMPTS = 5;
const WINDOW_MS = 3_600_000;
/** Per hour: starts per account and per call, and completion attempts per account. */
const STARTS_PER_ACCOUNT = 10;
const STARTS_PER_CALL = 5;
const COMPLETES_PER_ACCOUNT = 10;

const CALL_RE = /^[A-Z0-9]{3,9}$/;
const nowSec = () => Math.floor(Date.now() / 1000);

/** The base call (no SSID) of a submitted callsign, uppercased. */
export const baseCallOf = (c: unknown) =>
  (typeof c === "string" ? c : "").replace(/\*$/, "").trim().toUpperCase().split("-")[0]!;

/** A random URL-safe token of `bytes` random bytes. */
export function randomToken(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Caller {
  accountId: string;
  cs: string;
  body: Record<string, unknown>;
}

/**
 * Authenticate a start or completion: a session whose account holds the submitted base call. Returns the
 * caller, or the error response to send.
 */
export async function holderOf(req: Request, env: Env): Promise<Caller | Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in to verify a callsign" }, { status: 401 });
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const cs = baseCallOf(body.callsign);
  if (!CALL_RE.test(cs)) return json({ error: "callsign required" }, { status: 400 });
  if (!(await accountHoldsCall(env, me.accountId, cs)))
    return json({ error: "add this callsign to your account before verifying it" }, { status: 403 });
  return { accountId: me.accountId, cs, body };
}

/** Issue (or replace) the caller's challenge for `method`. Returns null when the start rate is exceeded. */
export async function issueChallenge(
  env: Env,
  c: Caller,
  method: ChallengeMethod,
  challenge: string,
): Promise<{ createdAt: number } | null> {
  const t = Date.now();
  if (
    (await rateLimitedDurable(env, `${method}-start:acct:${c.accountId}`, t, STARTS_PER_ACCOUNT, WINDOW_MS)) ||
    (await rateLimitedDurable(env, `${method}-start:call:${c.cs}`, t, STARTS_PER_CALL, WINDOW_MS))
  )
    return null;
  const createdAt = nowSec();
  await env.DB.prepare(
    `INSERT INTO callsign_challenges (callsign, method, account_id, challenge, attempts, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(callsign, method) DO UPDATE SET account_id=excluded.account_id, challenge=excluded.challenge,
       attempts=0, created_at=excluded.created_at`,
  )
    .bind(c.cs, method, c.accountId, challenge, createdAt)
    .run();
  return { createdAt };
}

/** Too many completion attempts from this account in the window. */
export async function completionLimited(env: Env, c: Caller, method: ChallengeMethod): Promise<boolean> {
  return rateLimitedDurable(env, `${method}-check:acct:${c.accountId}`, Date.now(), COMPLETES_PER_ACCOUNT, WINDOW_MS);
}

/**
 * The caller's outstanding challenge for `method`: started by this account, within `ttlSec`, and not
 * locked by failed attempts. Null when there is none.
 */
export async function openChallenge(
  env: Env,
  c: Caller,
  method: ChallengeMethod,
  ttlSec: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT account_id, challenge, attempts, created_at FROM callsign_challenges WHERE callsign=? AND method=?",
  )
    .bind(c.cs, method)
    .first<{ account_id: string; challenge: string; attempts: number; created_at: number }>();
  if (!row || row.account_id !== c.accountId) return null;
  if (nowSec() - row.created_at > ttlSec || row.attempts >= CHALLENGE_MAX_ATTEMPTS) return null;
  return row.challenge;
}

/** Count a failed completion against the challenge. */
export async function failAttempt(env: Env, c: Caller, method: ChallengeMethod, challenge: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE callsign_challenges SET attempts = attempts + 1 WHERE callsign=? AND method=? AND challenge=?",
  )
    .bind(c.cs, method, challenge)
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
