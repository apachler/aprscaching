// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId } from "./auth.js";

const CHALLENGE_TTL_SEC = 15 * 60; // a code is good for 15 minutes
const MAX_ATTEMPTS = 5; // wrong guesses before the challenge locks (SR-SEC-07)

/** A cryptographically-random 6-digit code (Math.random is predictable → brute-forceable). */
function sixDigitCode(): string {
  const n = (crypto.getRandomValues(new Uint32Array(1))[0]! % 900000) + 100000;
  return String(n);
}
/** Constant-time string compare so a wrong code can't be recovered by response timing (SR-SEC-08). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ingestOk = (req: Request, env: Env) => (req.headers.get("x-ingest-secret") ?? "") === env.INGEST_SECRET;

/** Start an APRS message-challenge: queue a one-time code to be sent to the callsign over APRS. */
export async function startAprsChallenge(req: Request, env: Env): Promise<Response> {
  // SR-SEC-07/14: a challenge may be requested only by a signed-in account (the confirm is bound to
  // it) or the trusted backend (ingest secret — e.g. a CLI/LoTW flow). A public, unauthenticated
  // caller can no longer farm codes or spam outbound APRS.
  const me = await sessionAccountId(req, env);
  if (!me && !ingestOk(req, env)) return json({ error: "sign in to verify a callsign" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = String(callsign ?? "").toUpperCase();
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const code = sixDigitCode();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO callsign_verifications (callsign, method, status, challenge, account_id, attempts, created_at)
     VALUES (?, 'aprs_msg', 'pending', ?, ?, 0, ?)
     ON CONFLICT(callsign) DO UPDATE SET method='aprs_msg', status='pending', challenge=excluded.challenge,
       account_id=excluded.account_id, attempts=0, created_at=excluded.created_at`,
  )
    .bind(cs, code, me?.accountId ?? null, now)
    .run();
  // queue an APRS message to the user's callsign via the outbox (ingest delivers it)
  await env.DB.prepare(
    `INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload)
     VALUES (?, 'APRSCG', 'APZACG', 'message', ?)`,
  )
    .bind(now, `:${cs.padEnd(9)}:aprscaching code ${code}`)
    .run();
  return json({ sent: true });
}

export async function confirmAprsChallenge(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  const trusted = ingestOk(req, env);
  if (!me && !trusted) return json({ error: "sign in to verify a callsign" }, { status: 401 });
  const { callsign, code } = (await req.json().catch(() => ({}))) as { callsign?: string; code?: string };
  const cs = String(callsign ?? "").toUpperCase();
  const row = await env.DB.prepare(
    "SELECT challenge, account_id, attempts, created_at, status FROM callsign_verifications WHERE callsign = ?",
  )
    .bind(cs)
    .first<{ challenge: string; account_id: string | null; attempts: number; created_at: number; status: string }>();
  const now = Math.floor(Date.now() / 1000);
  // an active challenge only — and, for a browser session, one THIS account started (the trusted
  // backend may confirm any pending challenge it drove).
  if (!row || row.status !== "pending" || (me && !trusted && row.account_id !== me.accountId))
    return json({ verified: false, error: "no active challenge" }, { status: 400 });
  if (now - row.created_at > CHALLENGE_TTL_SEC)
    return json({ verified: false, error: "challenge expired — request a new code" }, { status: 400 });
  if (row.attempts >= MAX_ATTEMPTS)
    return json({ verified: false, error: "too many attempts — request a new code" }, { status: 429 });
  if (!timingSafeEqual(row.challenge ?? "", String(code ?? ""))) {
    await env.DB.prepare(
      "UPDATE callsign_verifications SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END WHERE callsign = ?",
    )
      .bind(MAX_ATTEMPTS, cs)
      .run();
    return json({ verified: false }, { status: 400 });
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE callsign_verifications SET status='verified', verified_at=? WHERE callsign=?").bind(now, cs),
    env.DB.prepare("UPDATE accounts SET verified=1, verify_method='aprs_msg', verified_at=? WHERE callsign=?").bind(
      now,
      cs,
    ),
    // mirror onto the held base call (account_callsigns) so a verified call keeps its status when
    // the account later switches its active call to (or away from) this one.
    env.DB.prepare("UPDATE account_callsigns SET verified=1, method='aprs_msg', verified_at=? WHERE callsign=?").bind(
      now,
      cs,
    ),
  ]);
  return json({ verified: true });
}

export async function isCallsignVerified(env: Env, callsign: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT status FROM callsign_verifications WHERE callsign = ?")
    .bind(callsign)
    .first<{ status: string }>();
  return r?.status === "verified";
}

/** GET /verify/aprs/status?callsign= — control-verification state of a callsign's BASE call. */
export async function aprsVerifyStatus(req: Request, env: Env): Promise<Response> {
  const cs = (new URL(req.url).searchParams.get("callsign") ?? "").toUpperCase().split("-")[0]!;
  if (cs.length < 3) return json({ verified: false });
  return json({ verified: await isCallsignVerified(env, cs) });
}
