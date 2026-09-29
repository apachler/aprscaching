// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * callsign.ts — callsign control-verification: proof that an account controls the licence it holds.
 * A verified base call (every SSID inherits it) gates transmitting and the sysop role.
 *
 * Control of a licence is never proven by reading a code back: APRS-IS is a public feed, so a code sent
 * to a station over it is readable by anyone. A call becomes verified by a transmission heard on the
 * air, by a credential from a body that reviewed the licence (ARDC, ARRL), or by the people who run the
 * instance:
 *
 *  - `rf_heard` — the signed-in holder asks for a code ({@link startAprsChallenge}), transmits
 *    `VERIFY <code>` to the service call from the call or any SSID of it, and a receiving site this
 *    instance attests hears it on its own radio ({@link completeRfChallenge}, from radiolog.ts).
 *    A MeshCom node on the operator's ingest box counts as such a site only for a message it heard
 *    directly over LoRa; a copy relayed across the mesh or through the MeshCom server does not.
 *  - `ampr_dns` — the holder publishes a code under their ARDC-delegated `<call>.ampr.org` name and the
 *    DNSSEC-validated answer carries it (verify_ampr.ts).
 *  - `lotw` — the holder signs a challenge with the key of their ARRL Logbook of The World callsign
 *    certificate, which chains to a LoTW CA the operator trusts (verify_lotw.ts).
 *  - `operator` — the instance operator confirms an `ADMIN_CALLSIGNS` call with the ingest secret
 *    (`tools/admin/verify-call.mjs`), which bootstraps the sysop role on a fresh instance.
 *  - `sysop` — a sysop verifies a call by hand for someone out of range of every attested site, with a
 *    note saying how; it is listed, revocable and logged in `account_events`.
 *
 * Every verification records its method, who vouched (`verified_by`) and, where useful, a note.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId, accountHoldsCall, secretOk, timingSafeEqual } from "./auth.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { serviceCall } from "./radiolog.js";
import { adminCalls } from "./admin.js";

/** A code is good for 30 minutes: long enough to walk to the radio and transmit. */
export const CHALLENGE_TTL_SEC = 30 * 60;
/** Wrong codes heard on air before the challenge locks. */
export const MAX_ATTEMPTS = 5;

/** A cryptographically-random 6-digit code (Math.random is predictable). */
function sixDigitCode(): string {
  const n = (crypto.getRandomValues(new Uint32Array(1))[0]! % 900000) + 100000;
  return String(n);
}

const baseOf = (c: string) => c.replace(/\*$/, "").trim().toUpperCase().split("-")[0]!;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Challenge starts a signed-in account may make per hour, across all its calls, and per callsign. */
const STARTS_PER_ACCOUNT = 10;
const STARTS_PER_CALL = 5;
const START_WINDOW_MS = 3_600_000;

/** The message text that completes a challenge. */
export const verifyText = (code: string) => `VERIFY ${code}`;

/** The code in a `VERIFY <code>` message (any case), `""` for a bare `VERIFY`, or null for any other text. */
export function parseVerifyMessage(text: string): string | null {
  // split on whitespace rather than match one pattern: radio text is attacker-controlled, and a regex with
  // two adjacent whitespace runs backtracks polynomially on long blank padding
  const words = text.trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== "verify" || words.length > 2) return null;
  return words[1] ?? "";
}

/**
 * POST /verify/aprs/start {callsign} — issue a code for a base call the signed-in account holds. Nothing
 * is transmitted: the answer names the service call to message and the exact text to send, and the
 * holder transmits it from their own radio.
 */
export async function startAprsChallenge(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in to verify a callsign" }, { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = baseOf(String(callsign ?? ""));
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  // a session proves control only of a licence its account already holds
  if (!(await accountHoldsCall(env, me.accountId, cs)))
    return json({ error: "add this callsign to your account before verifying it" }, { status: 403 });
  const t = Date.now();
  if (
    (await rateLimitedDurable(env, `aprs-start:acct:${me.accountId}`, t, STARTS_PER_ACCOUNT, START_WINDOW_MS)) ||
    (await rateLimitedDurable(env, `aprs-start:call:${cs}`, t, STARTS_PER_CALL, START_WINDOW_MS))
  )
    return json({ error: "too many verification codes requested — try again later" }, { status: 429 });
  const code = sixDigitCode();
  const now = nowSec();
  // A new challenge replaces any pending one but never revokes an existing verification: a verified
  // call stays verified (and keeps its method) while the new code is outstanding.
  await env.DB.prepare(
    `INSERT INTO callsign_verifications (callsign, method, status, challenge, account_id, attempts, created_at)
     VALUES (?, 'rf_heard', 'pending', ?, ?, 0, ?)
     ON CONFLICT(callsign) DO UPDATE SET
       method = CASE WHEN callsign_verifications.status = 'verified' THEN callsign_verifications.method ELSE 'rf_heard' END,
       status = CASE WHEN callsign_verifications.status = 'verified' THEN 'verified' ELSE 'pending' END,
       challenge=excluded.challenge, account_id=excluded.account_id, attempts=0, created_at=excluded.created_at`,
  )
    .bind(cs, code, me.accountId, now)
    .run();
  return json({ code, to: serviceCall(env), text: verifyText(code), expiresAt: now + CHALLENGE_TTL_SEC });
}

/**
 * Mark a base call verified by `method`, and mirror it onto the held base call (`account_callsigns`) and
 * the account's active call (`accounts`) of `accountId` — or of whichever account holds the call when
 * no account is given — so a verified call keeps its status when the account switches between its calls.
 */
/** How a call's control was proven. */
export type VerifyMethod = "rf_heard" | "ampr_dns" | "lotw" | "operator" | "sysop";

export async function markVerified(
  env: Env,
  cs: string,
  method: VerifyMethod,
  f: { accountId?: string | null; by?: string | null; note?: string | null },
): Promise<void> {
  const now = nowSec();
  const holder =
    f.accountId ??
    (
      await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
        .bind(cs)
        .first<{ account_id: string }>()
    )?.account_id ??
    null;
  const ops = [
    env.DB.prepare(
      `INSERT INTO callsign_verifications (callsign, method, status, challenge, attempts, created_at, verified_at, verified_by, note)
       VALUES (?, ?, 'verified', NULL, 0, ?, ?, ?, ?)
       ON CONFLICT(callsign) DO UPDATE SET status='verified', method=excluded.method, challenge=NULL, attempts=0,
         verified_at=excluded.verified_at, verified_by=excluded.verified_by, note=excluded.note`,
    ).bind(cs, method, now, now, f.by ?? null, f.note ?? null),
  ];
  if (holder) {
    ops.push(
      env.DB.prepare(
        "UPDATE account_callsigns SET verified=1, method=?, verified_at=? WHERE account_id=? AND callsign=?",
      ).bind(method, now, holder, cs),
      env.DB.prepare(
        "UPDATE accounts SET verified=1, verify_method=?, verified_at=? WHERE account_id=? AND (callsign=? OR callsign LIKE ?)",
      ).bind(method, now, holder, cs, `${cs}-%`),
    );
  }
  await env.DB.batch(ops);
}

/** What an on-air `VERIFY` did: completed the challenge, a wrong code, or nothing to answer. */
export type RfChallengeOutcome = "verified" | "wrong" | "none";

/**
 * Complete a challenge from a `VERIFY <code>` message. The caller has established that the message was
 * heard on the air at an attested site; this checks the rest: the sender's base call is the challenge's
 * call, a challenge is outstanding and within its TTL, the attempts cap is not reached, and the code
 * matches. A wrong code counts an attempt and locks a pending challenge at the cap; an already-verified
 * call keeps its status whatever is sent.
 */
export async function completeRfChallenge(
  env: Env,
  src: string,
  code: string,
  site: string | null,
): Promise<RfChallengeOutcome> {
  const cs = baseOf(src);
  const row = await env.DB.prepare(
    "SELECT challenge, account_id, attempts, created_at, status FROM callsign_verifications WHERE callsign = ?",
  )
    .bind(cs)
    .first<{
      challenge: string | null;
      account_id: string | null;
      attempts: number;
      created_at: number;
      status: string;
    }>();
  if (!row || !row.challenge || row.status === "failed") return "none";
  if (nowSec() - row.created_at > CHALLENGE_TTL_SEC || row.attempts >= MAX_ATTEMPTS) return "none";
  // the challenge binds to the account that started it, and only while that account still holds the call
  if (!row.account_id || !(await accountHoldsCall(env, row.account_id, cs))) return "none";
  if (!timingSafeEqual(row.challenge, code)) {
    await env.DB.prepare(
      "UPDATE callsign_verifications SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? AND status <> 'verified' THEN 'failed' ELSE status END WHERE callsign = ?",
    )
      .bind(MAX_ATTEMPTS, cs)
      .run();
    return "wrong";
  }
  // Claim the code before writing, so two copies of the message heard at once verify once.
  const claim = await env.DB.prepare(
    "UPDATE callsign_verifications SET challenge = NULL WHERE callsign = ? AND challenge = ?",
  )
    .bind(cs, row.challenge)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return "none";
  await markVerified(env, cs, "rf_heard", { accountId: row.account_id, by: site ? site.toUpperCase() : null });
  return "verified";
}

export async function isCallsignVerified(env: Env, callsign: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT status FROM callsign_verifications WHERE callsign = ?")
    .bind(callsign)
    .first<{ status: string }>();
  return r?.status === "verified";
}

/** GET /verify/aprs/status?callsign= — control-verification state of a callsign's BASE call. */
export async function aprsVerifyStatus(req: Request, env: Env): Promise<Response> {
  const cs = baseOf(new URL(req.url).searchParams.get("callsign") ?? "");
  if (cs.length < 3) return json({ verified: false });
  return json({ verified: await isCallsignVerified(env, cs) });
}

/**
 * POST /verify/operator {callsign} with `x-ingest-secret` — the operator CLI confirms the operator's own
 * call. Only a call listed in `ADMIN_CALLSIGNS` qualifies, so the ingest secret (which also sits on the
 * ingest box) cannot verify arbitrary calls.
 */
export async function handleOperatorVerify(req: Request, env: Env): Promise<Response> {
  if (!secretOk(req.headers.get("x-ingest-secret"), env.INGEST_SECRET))
    return new Response("unauthorized", { status: 401 });
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = baseOf(String(callsign ?? ""));
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const listed = [...adminCalls(env)].some((c) => baseOf(c) === cs);
  if (!listed) return json({ error: `${cs} is not listed in ADMIN_CALLSIGNS` }, { status: 403 });
  await markVerified(env, cs, "operator", { by: "operator" });
  return json({ verified: true, callsign: cs, method: "operator" });
}

// ---------------------------------------------------------------- sysop manual verification

const NOTE_MIN = 3;
const NOTE_MAX = 200;
const CALL_RE = /^[A-Z0-9]{3,9}$/;

async function logEvent(env: Env, cs: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, ?, ?, ?)")
    .bind(cs, action, JSON.stringify(detail), nowSec())
    .run();
}

/** GET /api/admin/verifications — the calls verified by hand, newest first. The caller has passed requireSysop. */
export async function listSysopVerifications(env: Env): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT v.callsign, v.verified_by AS verifiedBy, v.note, v.verified_at AS verifiedAt,
              EXISTS (SELECT 1 FROM account_callsigns ac WHERE ac.callsign = v.callsign) AS held
         FROM callsign_verifications v WHERE v.method = 'sysop' AND v.status = 'verified'
         ORDER BY v.verified_at DESC, v.callsign LIMIT 500`,
    ).all<{ callsign: string; verifiedBy: string | null; note: string | null; verifiedAt: number; held: number }>()
  ).results;
  return json({ verifications: rows.map((r) => ({ ...r, held: r.held === 1 })) });
}

/**
 * POST /api/admin/verifications {callsign, note} — a sysop verifies a call by hand. The note (how control
 * was checked) is required. A call already verified another way is left as it is.
 */
export async function sysopVerify(req: Request, env: Env, sysopCall: string): Promise<Response> {
  const { callsign, note } = (await req.json().catch(() => ({}))) as { callsign?: string; note?: string };
  const cs = baseOf(String(callsign ?? ""));
  if (!CALL_RE.test(cs)) return json({ error: "a valid callsign is required" }, { status: 400 });
  const why = String(note ?? "").trim();
  if (why.length < NOTE_MIN || why.length > NOTE_MAX)
    return json(
      { error: `a note of ${NOTE_MIN}–${NOTE_MAX} characters saying how control was checked is required` },
      {
        status: 400,
      },
    );
  const cur = await env.DB.prepare("SELECT status, method FROM callsign_verifications WHERE callsign=?")
    .bind(cs)
    .first<{ status: string; method: string | null }>();
  if (cur?.status === "verified")
    return json({ error: `${cs} is already verified (${cur.method ?? "unknown"})` }, { status: 409 });
  const by = baseOf(sysopCall);
  await markVerified(env, cs, "sysop", { by, note: why });
  await logEvent(env, cs, "sysop_verified", { by, note: why });
  return json({ verified: true, callsign: cs, method: "sysop", verifiedBy: by, note: why }, { status: 201 });
}

/** DELETE /api/admin/verifications/:callsign — revoke a sysop verification (only that method). */
export async function sysopRevoke(env: Env, callsign: string, sysopCall: string): Promise<Response> {
  const cs = baseOf(callsign);
  const cur = await env.DB.prepare("SELECT 1 AS x FROM callsign_verifications WHERE callsign=? AND method='sysop'")
    .bind(cs)
    .first();
  if (!cur) return json({ error: `${cs} has no sysop verification` }, { status: 404 });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM callsign_verifications WHERE callsign=? AND method='sysop'").bind(cs),
    env.DB.prepare(
      "UPDATE account_callsigns SET verified=0, method=NULL, verified_at=NULL WHERE callsign=? AND method='sysop'",
    ).bind(cs),
    env.DB.prepare(
      "UPDATE accounts SET verified=0, verify_method=NULL, verified_at=NULL WHERE (callsign=? OR callsign LIKE ?) AND verify_method='sysop'",
    ).bind(cs, `${cs}-%`),
    // device keys registered while the call counted as verified no longer carry that badge
    env.DB.prepare("UPDATE callsign_keys SET verified=0 WHERE callsign=? OR callsign LIKE ?").bind(cs, `${cs}-%`),
  ]);
  await logEvent(env, cs, "sysop_revoked", { by: baseOf(sysopCall) });
  return json({ revoked: true, callsign: cs });
}
