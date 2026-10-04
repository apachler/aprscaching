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
 *  - `operator` — the instance operator confirms an `ADMIN_CALLSIGNS` call with the operator secret
 *    (`tools/admin/verify-call.mjs`), which bootstraps the sysop role on a fresh instance.
 *  - `sysop` — a sysop verifies a call by hand for someone out of range of every attested site, with a
 *    note saying how and after confirming which account holds the call; it is listed, revocable and logged
 *    in `account_events`.
 *
 * Each method also completes a claim (claims.ts): the licensee of a call an unproven account holds proves
 * control with the claim's token in place of a session, and the call moves to them.
 *
 * Every verification records its method, who vouched (`verified_by`) and, where useful, a note.
 *
 * `callsign_verifications` (status `verified`, keyed by base call) is the one record of a verification.
 * Every surface that shows or gates on it — the session, the held calls, device keys and their
 * federation feed, TX, the sysop role — reads it through {@link verificationOf} / {@link verificationsOf},
 * so a verification or a revocation shows everywhere at once. A claim of a call nobody held starts
 * unverified (`holdCall` in auth.ts clears what was recorded before).
 */
import { nowS } from "./util/time.js";
import { randomInt } from "./util/random.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { baseCall } from "@aprscaching/aprs";
import { sessionIdentity, accountHoldsCall, timingSafeEqual, operatorSecretOk } from "./auth.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { serviceCall } from "./servicecall.js";
import { adminCalls } from "./admin.js";
import { attestedSites } from "./attestedsites.js";
import type { SqlStatement } from "./runtime.js";
import {
  claimByToken,
  claimOpen,
  claimPrincipal,
  rfClaimsFor,
  completeClaim,
  callsignView,
  type Claim,
} from "./claims.js";

/**
 * The receiving-site calls that can hear a `VERIFY` message: the attested sites, sorted. Site calls are
 * public (they appear in every frame the site gates), so naming them to the holder discloses nothing.
 */
export async function listeningSites(env: Env): Promise<string[]> {
  return [...(await attestedSites(env))].sort();
}

/** A code is good for 30 minutes: long enough to walk to the radio and transmit. */
const CHALLENGE_TTL_SEC = 30 * 60;
/** Wrong codes heard on air before the challenge locks. */
const MAX_ATTEMPTS = 5;

/** A uniformly random 6-digit code from the CSPRNG (Math.random is predictable). */
function sixDigitCode(): string {
  return String(randomInt(900_000) + 100_000);
}

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
  const { callsign, claim: token } = (await req.json().catch(() => ({}))) as { callsign?: string; claim?: unknown };
  const cs = baseCall(String(callsign ?? ""));
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  // a claim's token stands in for a session: its code waits on the claim, apart from the holder's own
  const claim = token === undefined ? null : await claimByToken(env, token);
  if (token !== undefined && (!claim || !claimOpen(claim) || claim.callsign !== cs))
    return json({ error: "no open claim on this callsign — start the claim again" }, { status: 409 });
  const me = claim ? null : await sessionIdentity(req, env);
  if (!claim && !me) return json({ error: "sign in to verify a callsign" }, { status: 401 });
  // a session proves control only of a licence its account already holds
  if (me && !(await accountHoldsCall(env, me.accountId, cs)))
    return json({ error: "add this callsign to your account before verifying it" }, { status: 403 });
  const starter = claim ? claimPrincipal(claim.id) : me!.accountId;
  // Without an attested receiving site nothing can hear the reply, so a code would only run out.
  const sites = await listeningSites(env);
  if (sites.length === 0)
    return json(
      {
        error: "this instance has no receiving station yet — ask the operator, or use another method",
        reason: "no_receiving_site",
      },
      { status: 409 },
    );
  const t = Date.now();
  if (
    (await rateLimitedDurable(env, `aprs-start:acct:${starter}`, t, STARTS_PER_ACCOUNT, START_WINDOW_MS)) ||
    // a claimant's starts and the holder's count apart, so neither can use up the other's
    (await rateLimitedDurable(env, `aprs-start:${claim ? "claim" : "call"}:${cs}`, t, STARTS_PER_CALL, START_WINDOW_MS))
  )
    return json({ error: "too many verification codes requested — try again later" }, { status: 429 });
  const code = sixDigitCode();
  const now = nowS();
  if (claim) {
    await env.DB.prepare(
      "UPDATE callsign_claims SET rf_code = ?, rf_attempts = 0, rf_created_at = ? WHERE id = ? AND status = 'open'",
    )
      .bind(code, now, claim.id)
      .run();
    return json({ code, to: serviceCall(env), text: verifyText(code), expiresAt: now + CHALLENGE_TTL_SEC, sites });
  }
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
    .bind(cs, code, starter, now)
    .run();
  return json({ code, to: serviceCall(env), text: verifyText(code), expiresAt: now + CHALLENGE_TTL_SEC, sites });
}

/** How a call's control was proven. */
export type VerifyMethod = "rf_heard" | "ampr_dns" | "lotw" | "operator" | "sysop";

/** The one write of a verification, as a statement for a batch: base call `cs` is verified by `method`. */
export function verifiedStmt(
  env: Env,
  cs: string,
  method: VerifyMethod,
  f: { by?: string | null; note?: string | null },
): SqlStatement {
  const now = nowS();
  return env.DB.prepare(
    `INSERT INTO callsign_verifications (callsign, method, status, challenge, attempts, created_at, verified_at, verified_by, note)
     VALUES (?, ?, 'verified', NULL, 0, ?, ?, ?, ?)
     ON CONFLICT(callsign) DO UPDATE SET status='verified', method=excluded.method, challenge=NULL, attempts=0,
       verified_at=excluded.verified_at, verified_by=excluded.verified_by, note=excluded.note`,
  ).bind(baseCall(cs), method, now, now, f.by ?? null, f.note ?? null);
}

/** Mark a base call verified by `method`. Every SSID inherits it. */
async function markVerified(
  env: Env,
  cs: string,
  method: VerifyMethod,
  f: { by?: string | null; note?: string | null },
): Promise<void> {
  await verifiedStmt(env, cs, method, f).run();
}

/**
 * A verification method succeeded for `c`: verify the call the caller holds, or — for a claim — move the call
 * to the claimant, verified (claims.ts). Returns the error that refused a claim, or null.
 */
export async function recordProof(
  env: Env,
  c: { cs: string; claim?: Claim | null },
  method: VerifyMethod,
  f: { by?: string | null; note?: string | null },
): Promise<string | null> {
  if (!c.claim) {
    await markVerified(env, c.cs, method, f);
    return null;
  }
  const done = await completeClaim(env, c.claim, method, f);
  return done.ok ? null : done.error;
}

/**
 * A `VERIFY <code>` heard from `cs` that answers an open claim on the call: the code is checked against each
 * claim's on-air code, and a match completes that claim. Null when no claim waits for a code.
 */
async function completeRfClaim(
  env: Env,
  cs: string,
  code: string,
  site: string | null,
): Promise<RfChallengeOutcome | null> {
  const open = (await rfClaimsFor(env, cs)).filter(
    (c) => c.rfCreatedAt !== null && nowS() - c.rfCreatedAt <= CHALLENGE_TTL_SEC && c.rfAttempts < MAX_ATTEMPTS,
  );
  if (open.length === 0) return null;
  const hit = open.find((c) => timingSafeEqual(c.rfCode ?? "", code));
  if (!hit) return null;
  // spend the code before the call moves, so two copies of the message heard at once complete it once
  const spent = await env.DB.prepare("UPDATE callsign_claims SET rf_code = NULL WHERE id = ? AND rf_code = ?")
    .bind(hit.id, hit.rfCode)
    .run();
  if ((spent.meta?.changes ?? 0) !== 1) return "none";
  const done = await completeClaim(env, hit, "rf_heard", { by: site ? site.toUpperCase() : null });
  return done.ok ? "verified" : "none";
}

/** Count a wrong on-air code against every open claim on the call that waits for one. */
async function failRfClaims(env: Env, cs: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE callsign_claims SET rf_attempts = rf_attempts + 1 WHERE callsign = ? AND status = 'open' AND rf_code IS NOT NULL",
  )
    .bind(cs)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** What an on-air `VERIFY` did: completed the challenge, a wrong code, or nothing to answer. */
type RfChallengeOutcome = "verified" | "wrong" | "none";

/**
 * Complete a challenge from a `VERIFY <code>` message. The caller has established that the message was
 * heard on the air at an attested site; this checks the rest: the sender's base call is the challenge's
 * call, a challenge is outstanding and within its TTL, the attempts cap is not reached, and the code
 * matches. A wrong code counts an attempt and locks a pending challenge at the cap; an already-verified
 * call keeps its status whatever is sent. A code that answers an open claim on the call completes the claim
 * instead (claims.ts); a wrong code counts against the claims too.
 */
export async function completeRfChallenge(
  env: Env,
  src: string,
  code: string,
  site: string | null,
): Promise<RfChallengeOutcome> {
  const cs = baseCall(src);
  const claimed = await completeRfClaim(env, cs, code, site);
  if (claimed) return claimed;
  const own = await completeHolderChallenge(env, cs, code, site);
  if (own !== "wrong" && own !== "none") return own;
  return (await failRfClaims(env, cs)) ? "wrong" : own;
}

/** {@link completeRfChallenge} for the holder's own challenge. */
async function completeHolderChallenge(
  env: Env,
  cs: string,
  code: string,
  site: string | null,
): Promise<RfChallengeOutcome> {
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
  if (nowS() - row.created_at > CHALLENGE_TTL_SEC || row.attempts >= MAX_ATTEMPTS) return "none";
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
  await markVerified(env, cs, "rf_heard", { by: site ? site.toUpperCase() : null });
  return "verified";
}

/** A proven control of a base call: how, and when. */
export interface Verification {
  method: string | null;
  verifiedAt: number | null;
}

/** Base calls per query, so one statement binds a bounded number of parameters. */
const VERIFY_BATCH = 90;

/** The verification of each call's base call, keyed by base call; unverified calls are absent. */
export async function verificationsOf(env: Env, calls: readonly string[]): Promise<Map<string, Verification>> {
  const bases = [...new Set(calls.map(baseCall).filter((b) => b.length > 0))];
  const out = new Map<string, Verification>();
  for (let i = 0; i < bases.length; i += VERIFY_BATCH) {
    const chunk = bases.slice(i, i + VERIFY_BATCH);
    const rows = (
      await env.DB.prepare(
        `SELECT callsign, method, verified_at FROM callsign_verifications
          WHERE status = 'verified' AND callsign IN (${chunk.map(() => "?").join(",")})`,
      )
        .bind(...chunk)
        .all<{ callsign: string; method: string | null; verified_at: number | null }>()
    ).results;
    for (const r of rows) out.set(r.callsign, { method: r.method, verifiedAt: r.verified_at });
  }
  return out;
}

/** The verification of a call's base call, or null. */
export async function verificationOf(env: Env, callsign: string): Promise<Verification | null> {
  return (await verificationsOf(env, [callsign])).get(baseCall(callsign)) ?? null;
}

/** Is the base call of `callsign` control-verified? Every SSID inherits its base call's verification. */
export async function isCallsignVerified(env: Env, callsign: string): Promise<boolean> {
  return (await verificationOf(env, callsign)) !== null;
}

/** GET /verify/aprs/status?callsign= — control-verification state of a callsign's BASE call. */
export async function aprsVerifyStatus(req: Request, env: Env): Promise<Response> {
  const cs = baseCall(new URL(req.url).searchParams.get("callsign") ?? "");
  if (cs.length < 3) return json({ verified: false });
  return json({ verified: await isCallsignVerified(env, cs) });
}

/**
 * POST /verify/operator {callsign} with `x-operator-secret` — the operator CLI confirms the operator's own
 * call. Only a call listed in `ADMIN_CALLSIGNS` qualifies, so even the operator secret cannot verify
 * arbitrary calls. Unset OPERATOR_SECRET ⇒ closed; the ingest secret never reaches it.
 *
 * Every answer names the account that holds the call (`holder`, null when none does), so the operator sees
 * whose account the verification lands on. `preview: true` answers with the holder and verifies nothing.
 */
export async function handleOperatorVerify(req: Request, env: Env): Promise<Response> {
  if (!operatorSecretOk(req, env)) return new Response("unauthorized", { status: 401 });
  const { callsign, preview } = (await req.json().catch(() => ({}))) as { callsign?: string; preview?: unknown };
  const cs = baseCall(String(callsign ?? ""));
  if (cs.length < 3) return json({ error: "callsign required" }, { status: 400 });
  const listed = [...adminCalls(env)].some((c) => baseCall(c) === cs);
  if (!listed) return json({ error: `${cs} is not listed in ADMIN_CALLSIGNS` }, { status: 403 });
  const holder = await holderIdentity(env, cs);
  if (preview === true) return json({ verified: await isCallsignVerified(env, cs), callsign: cs, holder });
  await markVerified(env, cs, "operator", { by: "operator" });
  return json({ verified: true, callsign: cs, method: "operator", holder });
}

/** Who holds a base call: the account, the call it operates, and the ways it signs in. */
export async function holderIdentity(
  env: Env,
  base: string,
): Promise<{ accountId: string; activeCallsign: string; passkeys: number; email: boolean; createdAt: number } | null> {
  const row = await env.DB.prepare(
    `SELECT a.account_id AS accountId, a.callsign AS activeCallsign, a.created_at AS createdAt,
            a.email IS NOT NULL AS email,
            (SELECT COUNT(*) FROM credentials c WHERE c.account_id = a.account_id) AS passkeys
       FROM account_callsigns ac JOIN accounts a ON a.account_id = ac.account_id
      WHERE ac.callsign = ?`,
  )
    .bind(base)
    .first<{ accountId: string; activeCallsign: string; createdAt: number; email: number; passkeys: number }>();
  return row
    ? {
        accountId: row.accountId,
        activeCallsign: row.activeCallsign,
        passkeys: Number(row.passkeys),
        email: !!row.email,
        createdAt: row.createdAt,
      }
    : null;
}

// ---------------------------------------------------------------- sysop manual verification

const NOTE_MIN = 3;
const NOTE_MAX = 200;
const CALL_RE = /^[A-Z0-9]{3,9}$/;

async function logEvent(env: Env, cs: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, ?, ?, ?)")
    .bind(cs, action, JSON.stringify(detail), nowS())
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
  const body = ((await req.json().catch(() => ({}))) ?? {}) as { callsign?: string; note?: string; holder?: unknown };
  const { callsign, note } = body;
  const cs = baseCall(String(callsign ?? ""));
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
  // The verification lands on whichever account holds the call, so the sysop names the account they checked:
  // `holder` is that account's id (null for a call nobody holds). Without it, or when another account holds
  // the call now, nothing is verified and the answer shows who holds it.
  const holder = (await holderIdentity(env, cs))?.accountId ?? null;
  if (!("holder" in body) || body.holder !== holder)
    return json(
      {
        error: holder
          ? `confirm that the account holding ${cs} is its licensee before verifying it`
          : `confirm that nobody holds ${cs} before verifying it`,
        reason: "confirm_holder",
        ...(await callsignView(env, cs)),
      },
      { status: 409 },
    );
  const by = baseCall(sysopCall);
  await markVerified(env, cs, "sysop", { by, note: why });
  await logEvent(env, cs, "sysop_verified", { by, note: why });
  return json({ verified: true, callsign: cs, method: "sysop", verifiedBy: by, note: why }, { status: 201 });
}

/** DELETE /api/admin/verifications/:callsign — revoke a sysop verification (only that method). */
export async function sysopRevoke(env: Env, callsign: string, sysopCall: string): Promise<Response> {
  const cs = baseCall(callsign);
  const cur = await env.DB.prepare("SELECT 1 AS x FROM callsign_verifications WHERE callsign=? AND method='sysop'")
    .bind(cs)
    .first();
  if (!cur) return json({ error: `${cs} has no sysop verification` }, { status: 404 });
  await env.DB.prepare("DELETE FROM callsign_verifications WHERE callsign=? AND method='sysop'").bind(cs).run();
  await logEvent(env, cs, "sysop_revoked", { by: baseCall(sysopCall) });
  return json({ revoked: true, callsign: cs });
}
