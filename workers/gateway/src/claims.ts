// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * claims.ts — how a held call changes hands: by proof of control, or by the sysop.
 *
 * Holding a call (`account_callsigns`) is not proof of holding the licence. While the holder has not proven
 * control, the licensee may take the call over: they open a claim ({@link handleClaimStart}) and complete any
 * control-verification method for the call with the claim's token instead of a session — on the air, through
 * ampr.org DNS or with a LoTW certificate (callsign.ts, verify_ampr.ts, verify_lotw.ts). The method's success
 * runs {@link completeClaim}: the call moves to the claimant, verified. A claimant without an account gets a
 * new one, and collects its session with the token ({@link handleClaimStatus}).
 *
 * A verified holder is never displaced this way; only the sysop releases a call from an account
 * ({@link handleAdminCallsign}). Nor is a call listed in ADMIN_CALLSIGNS that some account holds: that account
 * came in through the operator's link or a proof of control, and the operator settles it.
 *
 * What moves with the call, and what stays with the previous holder (`releaseCall`):
 *
 *  - The call itself, its SSIDs, and every sign-in path bound to it. The previous holder's sessions on it end.
 *  - What the previous holder wrote in the app while holding the call — the caches it owns, its logs, ratings,
 *    favourites, watches, stage unlocks, badges, saved views and read-API keys — stays with their account and
 *    is shown under the account's remaining call, or under the `FORMER` marker when it holds no other. The
 *    licensee never inherits it, and nobody reading it learns who the previous holder is.
 *  - The previous holder's device keys and station registrations on the call go: they spoke for the call,
 *    which is no longer theirs. Each key's withdrawal reaches the federation as a signed tombstone, and so
 *    does each moved find, whose federated copy still names the call.
 *  - What the radio sent under the call (positions, stations, APRS messages, weather) stays with the call.
 *
 * Every change of holder is written to `callsign_events`, and the previous holder is told in the app and by
 * email when their account has a confirmed address.
 */
import { nowS } from "./util/time.js";
import { bytesToB64url } from "./util/b64.js";
import type { Env } from "./env.js";
import type { SqlStatement } from "./runtime.js";
import { json } from "./app.js";
import { baseCall } from "@aprscaching/aprs";
import {
  sessionIdentity,
  baseHolder,
  holdCall,
  isRegistrableCall,
  isAdminCall,
  issueSessionCookie,
  authThrottled,
  sessionsEnabled,
  sessionUnavailable,
  formerMarker,
  isFormerMarker,
  callsignSuspension,
  suspendedCallText,
} from "./auth.js";
import { verificationOf, verifiedStmt, holderIdentity, type VerifyMethod } from "./callsign.js";
import { emitTombstones, type TombstoneItem } from "./tombstones.js";
import { instanceHost } from "./env.js";
import { sendEmail } from "./mail.js";
import { pushAlert } from "./notify.js";
import { licenceFor } from "./licence.js";

/** A claim stays open as long as the slowest method needs: an ampr.org record can take two days to publish. */
const CLAIM_TTL_SEC = 48 * 3600;
const CALL_RE = /^[A-Z0-9]{3,9}$/;
/** Claims opened per client address and per account in an hour. */
const CLAIM_LIMITS = { perIp: 10, perIdentity: 10, windowMs: 3_600_000 };

/** The challenge-store principal of a claim: a claim's challenge never collides with an account's. */
export const claimPrincipal = (id: string) => `claim:${id}`;

async function tokenHash(token: string): Promise<string> {
  return bytesToB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

export interface Claim {
  id: string;
  callsign: string;
  accountId: string | null;
  holderId: string | null;
  signup: boolean;
  status: string;
  rfCode: string | null;
  rfAttempts: number;
  rfCreatedAt: number | null;
  createdAt: number;
  completedAt: number | null;
}

interface ClaimRow {
  id: string;
  callsign: string;
  account_id: string | null;
  holder_id: string | null;
  signup: number;
  status: string;
  rf_code: string | null;
  rf_attempts: number;
  rf_created_at: number | null;
  created_at: number;
  completed_at: number | null;
}
const claimOf = (r: ClaimRow): Claim => ({
  id: r.id,
  callsign: r.callsign,
  accountId: r.account_id,
  holderId: r.holder_id,
  signup: r.signup === 1,
  status: r.status,
  rfCode: r.rf_code,
  rfAttempts: r.rf_attempts,
  rfCreatedAt: r.rf_created_at,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

/** The claim a bearer token names, in whatever state, or null. */
export async function claimByToken(env: Env, token: unknown): Promise<Claim | null> {
  if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
  const row = await env.DB.prepare("SELECT * FROM callsign_claims WHERE token_hash = ?")
    .bind(await tokenHash(token))
    .first<ClaimRow>();
  return row ? claimOf(row) : null;
}

/** Is the claim still waiting for its proof? */
export const claimOpen = (c: Claim): boolean => c.status === "open" && nowS() - c.createdAt <= CLAIM_TTL_SEC;

/** The open claims on a call that hold an on-air code, newest first. */
export async function rfClaimsFor(env: Env, cs: string): Promise<Claim[]> {
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM callsign_claims WHERE callsign = ? AND status = 'open' AND rf_code IS NOT NULL ORDER BY created_at DESC LIMIT 20",
    )
      .bind(cs)
      .all<ClaimRow>()
  ).results;
  return rows.map(claimOf).filter(claimOpen);
}

interface Refusal {
  status: number;
  error: string;
  reason: string;
}

/**
 * Why `claimant` (null: someone without an account) cannot claim `cs`, or null when they can. A claim
 * takes a call from an account that has not proven control of it, or registers an ADMIN_CALLSIGNS call
 * nobody holds; any other call nobody holds is simply registered or added.
 */
async function claimRefusal(env: Env, cs: string, claimant: string | null): Promise<Refusal | null> {
  if (!CALL_RE.test(cs) || !isRegistrableCall(cs)) return { status: 400, error: "invalid callsign", reason: "invalid" };
  // a call under a suspension that outlived its account's erasure is claimed by nobody until it ends
  const suspended = await callsignSuspension(env, cs);
  if (suspended) return { status: 403, error: suspendedCallText(suspended), reason: "suspended" };
  const holder = await baseHolder(env, cs);
  const admin = isAdminCall(env, cs);
  if (holder && holder === claimant) return { status: 409, error: "you already hold this callsign", reason: "yours" };
  if (holder && (await verificationOf(env, cs)))
    return {
      status: 409,
      error: `an account that has proven control holds ${cs} — ask the sysop of this instance`,
      reason: "held_verified",
    };
  if (holder && admin)
    return {
      status: 409,
      error: `${cs} is this instance's operator call — ask the operator`,
      reason: "operator_call",
    };
  if (!holder && !admin)
    return {
      status: 409,
      error: claimant ? "nobody holds this callsign — add it instead" : "nobody holds this callsign — sign up with it",
      reason: "unheld",
    };
  return null;
}

/**
 * POST /auth/claims {callsign} — open a claim on a call. A session is optional: a signed-in claimant's account
 * takes the call; without one, success opens a new account. The answer carries the claim's token once; the
 * verification methods take it as `claim` in place of a session.
 */
export async function handleClaimStart(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  const { callsign } = (await req.json().catch(() => ({}))) as { callsign?: string };
  const cs = baseCall(String(callsign ?? ""));
  const limited = await authThrottled(env, req, "claim-start", me?.accountId ?? "", CLAIM_LIMITS);
  if (limited) return limited;
  const refused = await claimRefusal(env, cs, me?.accountId ?? null);
  if (refused) return json({ error: refused.error, reason: refused.reason }, { status: refused.status });
  if (!me && !sessionsEnabled(env)) return sessionUnavailable();
  const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(24)));
  const id = crypto.randomUUID();
  const now = nowS();
  await env.DB.prepare(
    `INSERT INTO callsign_claims (id, token_hash, callsign, account_id, signup, holder_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(id, await tokenHash(token), cs, me?.accountId ?? null, me ? 0 : 1, await baseHolder(env, cs), now)
    .run();
  return json(
    { claim: token, callsign: cs, held: (await baseHolder(env, cs)) !== null, expiresAt: now + CLAIM_TTL_SEC },
    { status: 201 },
  );
}

/**
 * POST /auth/claims/status {claim} — where a claim stands: `open`, `done`, `refused` or `expired`. The first
 * answer that finds a sign-up claim done carries the new account's session; the token opens no other.
 */
export async function handleClaimStatus(req: Request, env: Env): Promise<Response> {
  const { claim } = (await req.json().catch(() => ({}))) as { claim?: unknown };
  const limited = await authThrottled(env, req, "claim-status", "", { perIp: 120, perIdentity: 0, windowMs: 60_000 });
  if (limited) return limited;
  const c = await claimByToken(env, claim);
  if (!c) return json({ error: "no such claim" }, { status: 404 });
  const status = c.status === "open" && !claimOpen(c) ? "expired" : c.status;
  const body = { status, callsign: c.callsign, method: c.status === "done" ? await claimMethod(env, c.id) : null };
  if (status !== "done" || !c.signup || !c.accountId) return json(body);
  const taken = await env.DB.prepare("UPDATE callsign_claims SET collected = 1 WHERE id = ? AND collected = 0")
    .bind(c.id)
    .run();
  if ((taken.meta?.changes ?? 0) !== 1) return json(body);
  if (!sessionsEnabled(env)) return sessionUnavailable();
  return json(
    { ...body, signedIn: true, licence: await licenceFor(env, c.callsign) },
    { headers: { "set-cookie": await issueSessionCookie(env, c.accountId, c.callsign) } },
  );
}

async function claimMethod(env: Env, id: string): Promise<string | null> {
  return (
    (
      await env.DB.prepare("SELECT method FROM callsign_claims WHERE id = ?")
        .bind(id)
        .first<{ method: string | null }>()
    )?.method ?? null
  );
}

/** The instance name the federation feeds carry, for tombstones written outside a request. */
const instanceName = (env: Env): string | null => env.INSTANCE ?? instanceHost(env);

/**
 * A claim's proof succeeded: move the call to the claimant, verified by `method`. The call must still be
 * claimable — held by the same unproven account, or by nobody — or the claim is refused.
 */
export async function completeClaim(
  env: Env,
  claim: Claim,
  method: VerifyMethod,
  f: { by?: string | null; note?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cs = claim.callsign;
  // spend the claim first, so two proofs arriving together move the call once
  const spent = await env.DB.prepare(
    "UPDATE callsign_claims SET status = 'completing' WHERE id = ? AND status = 'open'",
  )
    .bind(claim.id)
    .run();
  if ((spent.meta?.changes ?? 0) !== 1) return { ok: false, error: "this claim is no longer open" };
  const refuse = async (error: string) => {
    await env.DB.prepare("UPDATE callsign_claims SET status = 'refused', completed_at = ? WHERE id = ?")
      .bind(nowS(), claim.id)
      .run();
    return { ok: false as const, error };
  };
  const holder = await baseHolder(env, cs);
  if (
    claim.accountId &&
    !(await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE account_id = ?").bind(claim.accountId).first())
  )
    return refuse("the claiming account no longer exists");
  const refusal = await claimRefusal(env, cs, claim.accountId);
  if (refusal) return refuse(refusal.error);

  const now = nowS();
  const target = claim.accountId ?? crypto.randomUUID();
  const released = holder ? await releaseCall(env, holder, cs, now) : null;
  const stmts: SqlStatement[] = [...(released?.stmts ?? [])];
  if (claim.signup)
    stmts.push(
      env.DB.prepare("INSERT INTO accounts (callsign, account_id, created_at) VALUES (?, ?, ?)").bind(cs, target, now),
      env.DB.prepare("INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?, ?, ?, 1)").bind(
        target,
        cs,
        now,
      ),
    );
  stmts.push(
    ...holdCall(env, target, cs, claim.signup, now),
    verifiedStmt(env, cs, method, f),
    env.DB.prepare(
      "UPDATE callsign_claims SET status = 'done', account_id = ?, method = ?, completed_at = ? WHERE id = ?",
    ).bind(target, method, now, claim.id),
    // the call is proven now: every other open claim on it is moot
    env.DB.prepare(
      "UPDATE callsign_claims SET status = 'refused', completed_at = ? WHERE callsign = ? AND status = 'open' AND id != ?",
    ).bind(now, cs, claim.id),
    logEvent(env, cs, "claimed", { from: holder, to: target, actor: method }),
  );
  try {
    await env.DB.batch(stmts);
  } catch {
    // the call changed hands while this ran: the claim may be opened again
    await env.DB.prepare("UPDATE callsign_claims SET status = 'open' WHERE id = ? AND status = 'completing'")
      .bind(claim.id)
      .run();
    return { ok: false, error: "the callsign changed hands meanwhile — try again" };
  }
  if (released) await afterRelease(env, released, `its licensee proved control of it (${METHOD_WORDS[method]})`);
  return { ok: true };
}

const METHOD_WORDS: Record<VerifyMethod, string> = {
  rf_heard: "on the air",
  ampr_dns: "through ampr.org DNS",
  lotw: "with a LoTW certificate",
  operator: "with the operator's secret",
  sysop: "confirmed by the sysop",
};

/** One row of the holder-change trail. */
function logEvent(
  env: Env,
  cs: string,
  action: "claimed" | "released",
  e: { from: string | null; to: string | null; actor: string; note?: string | null },
): SqlStatement {
  return env.DB.prepare(
    "INSERT INTO callsign_events (callsign, action, from_account, to_account, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(cs, action, e.from, e.to, e.actor, e.note ?? null, nowS());
}

/** A release in preparation: its statements, and what to do once they are written. */
interface Release {
  stmts: SqlStatement[];
  tombstones: TombstoneItem[];
  holderId: string;
  callsign: string;
  /** The call the previous holder's content now shows under: a call it still holds, or its FORMER marker. */
  shownAs: string;
  /** The account holds no call any more. */
  callless: boolean;
  email: string | null;
}

/** `col` names `cs` or an SSID of it. */
const ofCall = (col: string) => `(${col} = ? OR ${col} LIKE ?)`;

/**
 * The statements that take base call `cs` from account `holderId`, for a batch. See the module comment for what
 * moves and what stays. Content the account wrote under the call from when it took the call on is rewritten to
 * the account's remaining call, or to a marker that names no call when it holds no other.
 */
async function releaseCall(env: Env, holderId: string, cs: string, now: number): Promise<Release> {
  const like = `${cs}-%`;
  const acct = await env.DB.prepare("SELECT callsign, email FROM accounts WHERE account_id = ?")
    .bind(holderId)
    .first<{ callsign: string; email: string | null }>();
  const row = await env.DB.prepare(
    "SELECT is_primary, added_at FROM account_callsigns WHERE account_id = ? AND callsign = ?",
  )
    .bind(holderId, cs)
    .first<{ is_primary: number; added_at: number }>();
  const since = row?.added_at ?? 0;
  const others = (
    await env.DB.prepare(
      "SELECT callsign, is_primary FROM account_callsigns WHERE account_id = ? AND callsign != ? ORDER BY is_primary DESC, added_at ASC, callsign ASC",
    )
      .bind(holderId, cs)
      .all<{ callsign: string; is_primary: number }>()
  ).results;
  const activeBase = acct ? baseCall(acct.callsign) : cs;
  const keepsActive = !!acct && activeBase !== cs && !isFormerMarker(acct.callsign);
  const callless = others.length === 0;
  const shownAs = keepsActive ? activeBase : (others[0]?.callsign ?? formerMarker());
  const newActive = keepsActive && acct ? acct.callsign : shownAs;
  const newPrimary =
    row?.is_primary === 1 && !callless
      ? keepsActive && others.some((o) => o.callsign === activeBase)
        ? activeBase
        : others[0]!.callsign
      : null;

  // the federated records that still name the call: the account's device keys and its moved finds
  const instance = instanceName(env);
  const keyIds = (
    await env.DB.prepare(`SELECT id FROM callsign_keys WHERE ${ofCall("callsign")}`)
      .bind(cs, like)
      .all<{ id: number }>()
  ).results;
  const findIds = (
    await env.DB.prepare(`SELECT id FROM cache_logs WHERE ${ofCall("logger_call")} AND ts >= ?`)
      .bind(cs, like, since)
      .all<{ id: number }>()
  ).results;
  const tombstones: TombstoneItem[] = instance
    ? [
        ...keyIds.map((k) => ({ kind: "key" as const, targetId: `${instance}:key:${k.id}` })),
        ...findIds.map((l) => ({ kind: "find" as const, targetId: `${instance}:find:${l.id}` })),
      ]
    : [];

  const moveRows = (table: string, col: string) => [
    // a row the remaining identity already has (the same favourite, the same badge) is dropped, not doubled
    env.DB.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${ofCall(col)}`).bind(shownAs, cs, like),
    env.DB.prepare(`DELETE FROM ${table} WHERE ${ofCall(col)}`).bind(cs, like),
  ];
  const logWindow = `${ofCall("logger_call")} AND ts >= ?`;
  const stmts: SqlStatement[] = [
    // a pending corroboration asks the network about the call's radio, which is no longer the logger's
    env.DB.prepare(
      `DELETE FROM corroboration_retries WHERE log_id IN (SELECT id FROM cache_logs WHERE ${logWindow})`,
    ).bind(cs, like, since),
    // one found per cache and person: a found the remaining identity already logged (or one under another
    // SSID of the call) is the same find, so only the first survives
    env.DB.prepare(
      `DELETE FROM cache_logs WHERE log_type = 'found' AND ${logWindow}
         AND cache_id IN (SELECT cache_id FROM cache_logs WHERE log_type = 'found' AND logger_call = ?)`,
    ).bind(cs, like, since, shownAs),
    env.DB.prepare(
      `DELETE FROM cache_logs WHERE log_type = 'found' AND ${logWindow}
         AND id NOT IN (SELECT MIN(id) FROM cache_logs WHERE log_type = 'found' AND ${logWindow} GROUP BY cache_id)`,
    ).bind(cs, like, since, cs, like, since),
    env.DB.prepare(`UPDATE cache_logs SET logger_call = ? WHERE ${logWindow}`).bind(shownAs, cs, like, since),
    // a cache moves with its owner's account; the bumped updated_at re-serves it to the federation
    env.DB.prepare(
      `UPDATE caches SET owner_call = ?, updated_at = ? WHERE ${ofCall("owner_call")} AND created_at >= ?`,
    ).bind(shownAs, now, cs, like, since),
    ...moveRows("cache_ratings", "callsign"),
    ...moveRows("favorites", "callsign"),
    ...moveRows("watches", "callsign"),
    ...moveRows("achievements", "callsign"),
    ...moveRows("stage_unlocks", "callsign"),
    env.DB.prepare(`UPDATE saved_views SET owner_call = ? WHERE ${ofCall("owner_call")}`).bind(shownAs, cs, like),
    // what spoke for the call goes: device keys, stations and weather keys registered on it, pending requests
    env.DB.prepare(`DELETE FROM callsign_keys WHERE ${ofCall("callsign")}`).bind(cs, like),
    env.DB.prepare(`DELETE FROM account_stations WHERE account_id = ? AND ${ofCall("callsign")}`).bind(
      holderId,
      cs,
      like,
    ),
    env.DB.prepare(`DELETE FROM wx_keys WHERE account_id = ? AND ${ofCall("callsign")}`).bind(holderId, cs, like),
    env.DB.prepare(`DELETE FROM cache_adoption_requests WHERE account_id = ? AND ${ofCall("callsign")}`).bind(
      holderId,
      cs,
      like,
    ),
    // sign-in material bound to the call: pending ceremonies and links, and the call a passkey was made under
    env.DB.prepare(`DELETE FROM auth_challenges WHERE ${ofCall("callsign")}`).bind(cs, like),
    env.DB.prepare(`DELETE FROM email_tokens WHERE ${ofCall("callsign")}`).bind(cs, like),
    env.DB.prepare(`UPDATE credentials SET callsign = ? WHERE account_id = ? AND ${ofCall("callsign")}`).bind(
      newPrimary ?? shownAs,
      holderId,
      cs,
      like,
    ),
    env.DB.prepare("DELETE FROM callsign_challenges WHERE callsign = ?").bind(cs),
    env.DB.prepare("DELETE FROM callsign_verifications WHERE callsign = ?").bind(cs),
    env.DB.prepare("DELETE FROM account_callsigns WHERE account_id = ? AND callsign = ?").bind(holderId, cs),
    ...(newPrimary
      ? [
          env.DB.prepare("UPDATE account_callsigns SET is_primary = 1 WHERE account_id = ? AND callsign = ?").bind(
            holderId,
            newPrimary,
          ),
        ]
      : []),
    // the account operates another call now (or none), and every session it had on this one ends
    env.DB.prepare("UPDATE accounts SET callsign = ?, session_gen = session_gen + 1 WHERE account_id = ?").bind(
      newActive,
      holderId,
    ),
    ...(keepsActive
      ? []
      : [
          env.DB.prepare(
            "INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?, ?, ?, ?)",
          ).bind(holderId, newActive, now, !callless && (await verificationOf(env, newActive)) ? 1 : 0),
        ]),
  ];
  return { stmts, tombstones, holderId, callsign: cs, shownAs, callless, email: acct?.email ?? null };
}

/** Once a release is written: publish its tombstones and tell the previous holder. */
async function afterRelease(env: Env, r: Release, why: string): Promise<void> {
  const instance = instanceName(env);
  if (instance && r.tombstones.length) await emitTombstones(env, instance, r.tombstones);
  const shown = isFormerMarker(r.shownAs) ? null : r.shownAs;
  const detail = `${r.callsign} is no longer on your account: ${why}.`;
  await env.DB.prepare("INSERT INTO watch_alerts (account_id, callsign, kind, detail, ts) VALUES (?, ?, ?, ?, ?)")
    .bind(r.holderId, r.callsign, "call_released", detail, nowS())
    .run();
  await pushAlert(env, r.holderId);
  if (!r.email) return;
  const rest = shown
    ? `Your account keeps everything else. The caches and finds you logged as ${r.callsign} now show under ${shown}.`
    : "Your account keeps your caches and finds, but holds no callsign now. To sign in again, ask for an email " +
      "link with the callsign you operate now; your caches and finds come with it.";
  await sendEmail(
    env,
    r.email,
    `${r.callsign} is no longer on your aprscaching account`,
    `${detail}\n\n${rest}\n\nIf ${r.callsign} is your licence, contact the sysop of this instance.`,
  );
}

/**
 * Give a callless account a call again: the account holds `cs` (unverified) as its primary and operates it,
 * and the content shown under its FORMER marker moves to it. For a batch; `marker` is the account's marker.
 */
export function reclaimStatements(
  env: Env,
  accountId: string,
  marker: string,
  cs: string,
  now: number,
): SqlStatement[] {
  const move = (table: string, col: string) =>
    env.DB.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`).bind(cs, marker);
  return [
    ...holdCall(env, accountId, cs, true, now),
    env.DB.prepare("UPDATE accounts SET callsign = ? WHERE account_id = ?").bind(cs, accountId),
    env.DB.prepare("INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?, ?, ?, 0)").bind(
      accountId,
      cs,
      now,
    ),
    move("cache_logs", "logger_call"),
    env.DB.prepare("UPDATE caches SET owner_call = ?, updated_at = ? WHERE owner_call = ?").bind(cs, now, marker),
    move("cache_ratings", "callsign"),
    move("favorites", "callsign"),
    move("watches", "callsign"),
    move("achievements", "callsign"),
    move("stage_unlocks", "callsign"),
    env.DB.prepare("UPDATE saved_views SET owner_call = ? WHERE owner_call = ?").bind(cs, marker),
    env.DB.prepare("UPDATE credentials SET callsign = ? WHERE account_id = ?").bind(cs, accountId),
  ];
}

// ---------------------------------------------------------------- the sysop's view of a call

const REASON_MIN = 3;
const REASON_MAX = 200;

/**
 * /api/admin/callsigns/:callsign — the sysop's view of a call. GET answers who holds it (the account, its other
 * calls and sign-in paths), how it is verified, open claims, and its holder-change trail. POST
 * `{action: "release", reason, holder}` detaches the call from its holder: `holder` must name the account the
 * sysop looked at, so a release never lands on an account they have not seen. The caller has passed requireSysop.
 */
export async function handleAdminCallsign(
  req: Request,
  env: Env,
  callsign: string,
  sysopCall: string,
): Promise<Response> {
  const cs = baseCall(callsign);
  if (!CALL_RE.test(cs)) return json({ error: "a valid callsign is required" }, { status: 400 });
  if (req.method === "GET") return json(await callsignView(env, cs));
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; reason?: unknown; holder?: unknown };
  if (body.action !== "release") return json({ error: "unknown action" }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return json({ error: `a reason of ${REASON_MIN}–${REASON_MAX} characters is required` }, { status: 400 });
  const holder = await baseHolder(env, cs);
  if (!holder) return json({ error: `no account holds ${cs}` }, { status: 404 });
  if (body.holder !== holder)
    return json(
      {
        error: `confirm the account that holds ${cs} before releasing it`,
        reason: "confirm_holder",
        ...(await callsignView(env, cs)),
      },
      { status: 409 },
    );
  const by = baseCall(sysopCall);
  const released = await releaseCall(env, holder, cs, nowS());
  try {
    await env.DB.batch([
      ...released.stmts,
      logEvent(env, cs, "released", { from: holder, to: null, actor: by, note: reason }),
    ]);
  } catch {
    return json({ error: `${cs} changed hands meanwhile — look it up again` }, { status: 409 });
  }
  await afterRelease(env, released, `the sysop of this instance released it (${reason})`);
  return json({ released: true, callsign: cs, shownAs: released.callless ? "FORMER" : released.shownAs });
}

/** Everything the sysop needs to decide about a call. */
export async function callsignView(env: Env, cs: string) {
  const holder = await holderIdentity(env, cs);
  const held = holder
    ? (
        await env.DB.prepare(
          "SELECT callsign, is_primary AS isPrimary FROM account_callsigns WHERE account_id = ? ORDER BY is_primary DESC, added_at",
        )
          .bind(holder.accountId)
          .all<{ callsign: string; isPrimary: number }>()
      ).results
    : [];
  const v = await env.DB.prepare(
    "SELECT method, verified_at AS verifiedAt, verified_by AS verifiedBy, note FROM callsign_verifications WHERE callsign = ? AND status = 'verified'",
  )
    .bind(cs)
    .first<{ method: string | null; verifiedAt: number | null; verifiedBy: string | null; note: string | null }>();
  const openClaims = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM callsign_claims WHERE callsign = ? AND status = 'open' AND created_at > ?",
    )
      .bind(cs, nowS() - CLAIM_TTL_SEC)
      .first<{ n: number }>()
  )?.n;
  const events = (
    await env.DB.prepare(
      `SELECT action, from_account AS fromAccount, to_account AS toAccount, actor, note, at
         FROM callsign_events WHERE callsign = ? ORDER BY id DESC LIMIT 20`,
    )
      .bind(cs)
      .all<Record<string, unknown>>()
  ).results;
  return {
    callsign: cs,
    adminCall: isAdminCall(env, cs),
    holder: holder && { ...holder, held: held.map((h) => ({ callsign: h.callsign, isPrimary: h.isPrimary === 1 })) },
    verification: v ?? null,
    openClaims: Number(openClaims ?? 0),
    events,
  };
}
