// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * account.ts — account data lifecycle: GDPR data export + erasure (right of access / erasure), and
 * account portability across federation peers. Sensitive actions are authorised by a signature from
 * a device key already registered to the callsign (or a matching passkey session) — see
 * accountActionMessage(). The server speaks SI/public data; this is where a user takes their data
 * out or has it removed.
 */
import { b64urlToBytes } from "./util/b64.js";
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";
import { json } from "./http.js";
import { accountActionMessage, FED_BBS_CATEGORY } from "@aprscaching/shared";
import { importVerifyKey, serveFeed, type FeedServeDef } from "./federation.js";
import { tombstoneSelect } from "./tombstones.js";
import { finishMediaDeletes, queueMediaDeletes } from "./mediadeletions.js";
import type { SqlStatement } from "./runtime.js";
import { isKeyRegistered } from "./keys.js";
import {
  sessionIdentity,
  accountDataSession,
  displayCall,
  accountHoldsCall,
  holdCall,
  unclaimableReason,
  WITHDRAWN,
  suspensionOf,
} from "./auth.js";
import { verificationOf, verificationsOf } from "./callsign.js";
import { rateLimitedDurable, clientIp } from "./corroborate_privacy.js";
import { serviceCall } from "./servicecall.js";
import { eraseAccountRegistries, exportAccountRegistries } from "./toolregistries.js";

const instanceOf = (env: Env, req: Request) => env.INSTANCE ?? new URL(req.url).host;

type AuthResult = { ok: true; body: any } | { ok: false; res: Response };

/** Authorise a signed account action (or a matching session). Consumes the JSON body. */
async function authorize(env: Env, req: Request, callsign: string, action: string): Promise<AuthResult> {
  const cs = callsign.toUpperCase();
  const body = (await req.json().catch(() => ({}))) as {
    key?: string;
    sig?: string;
    at?: number;
    [k: string]: unknown;
  };
  // a session acts for the calls its own account holds
  const me = await sessionIdentity(req, env);
  if (me && (await accountHoldsCall(env, me.accountId, cs))) return { ok: true, body };
  // a data-only session exports or erases its own callless account, named by its marker, and does nothing else
  if (action === "export" || action === "delete") {
    const data = await accountDataSession(req, env);
    if (data && data.marker.toUpperCase() === cs) return { ok: true, body };
  }
  if (!body.key || !body.sig || !body.at)
    return {
      ok: false,
      res: json({ error: "signed action required (key, sig, at) or a matching session" }, { status: 401 }),
    };
  if (Math.abs(nowS() - body.at) > 300)
    return { ok: false, res: json({ error: "stale signature (>5 min)" }, { status: 401 }) };
  if (!(await isKeyRegistered(env, cs, body.key)))
    return { ok: false, res: json({ error: "key not registered to this callsign" }, { status: 403 }) };
  try {
    const key = await importVerifyKey(body.key);
    const msg = new TextEncoder().encode(
      accountActionMessage({ action, callsign: cs, instance: instanceOf(env, req), at: body.at }),
    );
    const valid = await crypto.subtle.verify("Ed25519", key, b64urlToBytes(body.sig), msg);
    if (!valid) return { ok: false, res: json({ error: "invalid signature" }, { status: 401 }) };
  } catch {
    return { ok: false, res: json({ error: "invalid key/signature" }, { status: 401 }) };
  }
  return { ok: true, body };
}

const rows = async (env: Env, sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all()
  ).results;

/** The account behind a callsign — its active-call anchor, else the holder of its base call — its
 *  addresses (the confirmed one, and one still waiting for confirmation) and every base call that account
 *  holds (the callsign's own base first). */
async function accountScope(
  env: Env,
  cs: string,
): Promise<{ accountId: string | null; email: string | null; emails: string[]; calls: string[] }> {
  const base = baseCall(cs);
  const anchor = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?")
    .bind(cs)
    .first<{ account_id: string | null }>();
  const accountId =
    anchor?.account_id ??
    (
      await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
        .bind(base)
        .first<{ account_id: string }>()
    )?.account_id ??
    null;
  const addr = accountId
    ? await env.DB.prepare("SELECT email, pending_email FROM accounts WHERE account_id=?")
        .bind(accountId)
        .first<{ email: string | null; pending_email: string | null }>()
    : null;
  const email = addr?.email ?? null;
  const emails = [...new Set([email, addr?.pending_email ?? null].filter((e): e is string => !!e))];
  const held = accountId
    ? (
        await env.DB.prepare("SELECT callsign FROM account_callsigns WHERE account_id=?")
          .bind(accountId)
          .all<{ callsign: string }>()
      ).results.map((r) => r.callsign.toUpperCase())
    : [];
  return { accountId, email, emails, calls: [...new Set([base, ...held])] };
}

/**
 * The call a request's path names: `me` names the account of a data-only session by the marker its content
 * shows under, since an account holding no call has no call to name (auth.ts accountDataSession).
 */
async function namedCall(req: Request, env: Env, named: string): Promise<string> {
  if (named !== "me") return named;
  return (await accountDataSession(req, env))?.marker ?? named;
}

/** `col` names one of `calls` or an SSID of it — a SQL fragment plus its binds. */
function anyCall(col: string, calls: string[]): { sql: string; binds: string[] } {
  return {
    sql: `(${calls.map(() => `${col}=? OR ${col} LIKE ?`).join(" OR ")})`,
    binds: calls.flatMap((c) => [c, `${c}-%`]),
  };
}

/**
 * `col` names one of `calls` or an SSID of it, and is not the service call: the service call shares the sysop's
 * base call but carries the instance's own traffic and keys, never the sysop's personal data.
 */
function personalCall(env: Env, col: string, calls: string[]): { sql: string; binds: string[] } {
  const c = anyCall(col, calls);
  return { sql: `(${c.sql} AND ${col} != ?)`, binds: [...c.binds, serviceCall(env)] };
}

// ----------------------------------------------------- GDPR: export everything for a callsign
export async function handleAccountExport(req: Request, env: Env, named: string): Promise<Response> {
  const callsign = await namedCall(req, env, named);
  const auth = await authorize(env, req, callsign, "export");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  // The export covers the whole person — the account behind the call, whichever held call names it, and
  // every base call it holds with their SSIDs.
  const scope = await accountScope(env, cs);
  const acct = scope.accountId ?? "";
  const by = (col: string) => personalCall(env, col, scope.calls);
  const q = (sql: string, col: string) => rows(env, sql.replace("$CALLS", by(col).sql), ...by(col).binds);
  // control-verification comes from its one store and is shown on the rows it concerns
  const verification = await verificationOf(env, cs);
  const verifiedFlag = verification ? 1 : 0;
  const accountRow = await env.DB.prepare(
    `SELECT callsign, email, pending_email, created_at, display_name, home_grid, avatar_url, bio, links, public_contact,
            profile_public, announce_is, announce_tocall, notify_digest, tier, hide_nag, near_radio
       FROM accounts WHERE account_id=?`,
  )
    .bind(acct)
    .first<Record<string, unknown> & { callsign: string }>();
  const data = {
    instance: instanceOf(env, req),
    callsign: cs,
    exportedAt: nowS(),
    account: accountRow && {
      ...accountRow,
      verified: verifiedFlag,
      verify_method: verification?.method ?? null,
      verified_at: verification?.verifiedAt ?? null,
    },
    // every detail of the caches the person owns, and their stages
    caches: await q(
      `SELECT id, code, owner_call, title, type, status, difficulty, terrain, lat, lon, station_call, hint, description,
              min_trust, drive_in, country, tags, rating_policy, rendezvous, fed_scope, created_at, updated_at,
              removed_at, removed_reason
         FROM caches WHERE $CALLS ORDER BY id`,
      "owner_call",
    ),
    cacheStages: await q(
      `SELECT s.cache_id, s.stage_no, s.lat, s.lon, s.clue, s.unlock, s.radius_m, s.unlock_secret, s.media_key, s.media_bytes
         FROM cache_stages s JOIN caches c ON c.id = s.cache_id WHERE $CALLS ORDER BY s.cache_id, s.stage_no`,
      "c.owner_call",
    ),
    stageUnlocks: await q(
      "SELECT callsign, cache_id, stage_no, unlocked_at FROM stage_unlocks WHERE $CALLS ORDER BY unlocked_at",
      "callsign",
    ),
    logs: await q(
      "SELECT cache_id, logger_call, ts, log_type, verified, tier, comment, needs_maintenance, signer_key, signed_at FROM cache_logs WHERE $CALLS ORDER BY ts",
      "logger_call",
    ),
    positions: await q(
      "SELECT callsign, ts, lat, lon, heard_via, source FROM positions WHERE $CALLS ORDER BY ts",
      "callsign",
    ),
    // the APRS message log rows the person sent or was sent, on any of their calls, with the delivery state of
    // what they sent: when it went out on APRS-IS and when the addressee acknowledged it. The service call's
    // traffic (a sysop's base call with the service SSID) is the instance's, with others' Mailbox texts in it.
    messages: await rows(
      env,
      `SELECT ts, from_call, to_call, body, ack, direction, transport, sent_at, acked_at FROM messages WHERE ${by("from_call").sql} OR ${by("to_call").sql} ORDER BY ts`,
      ...by("from_call").binds,
      ...by("to_call").binds,
    ),
    keys: (await q("SELECT callsign, public_key, label, created_at FROM callsign_keys WHERE $CALLS", "callsign")).map(
      (k) => ({ ...(k as Record<string, unknown>), verified: verifiedFlag }),
    ),
    favorites: await q("SELECT callsign, cache_id FROM favorites WHERE $CALLS", "callsign"),
    watches: await q("SELECT callsign, cache_id FROM watches WHERE $CALLS", "callsign"),
    achievements: await q("SELECT callsign, badge, earned_at FROM achievements WHERE $CALLS", "callsign"),
    verifications: await q(
      "SELECT callsign, method, status, verified_at, verified_by, note FROM callsign_verifications WHERE $CALLS",
      "callsign",
    ),
    stations: await q(
      "SELECT callsign, lat, lon, symbol, description, roles, created_at FROM account_stations WHERE $CALLS",
      "callsign",
    ),
    radioCommands: await q(
      "SELECT from_call, command, cache_code, body, raw_text, port, status, reason, sent_at, decided_at FROM radio_commands WHERE $CALLS ORDER BY sent_at",
      "from_call",
    ),
    weatherKeys: await q("SELECT callsign, station_id, created_at, last_seen FROM wx_keys WHERE $CALLS", "callsign"),
    // the readings of the person's weather stations, as this instance stored them under their calls
    weatherReadings: await q(
      `SELECT station, ts, temp_c, humidity, pressure_hpa, wind_dir, wind_kn, gust_kn, rain_mm, rain_24h_mm, luminosity_wm2,
              source FROM sensor_readings WHERE $CALLS ORDER BY ts`,
      "station",
    ),
    // radio traffic queued for APRS-IS from the person's calls or addressed to them (the addressee is the
    // nine-character field that opens an APRS message payload)
    aprsOutbox: await rows(
      env,
      `SELECT ts, src_call, tocall, kind, payload, target, status, sent_at FROM aprs_outbox
        WHERE ${by("src_call").sql} OR (kind = 'message' AND ${by("rtrim(substr(payload, 2, 9))").sql}) ORDER BY ts`,
      ...by("src_call").binds,
      ...by("rtrim(substr(payload, 2, 9))").binds,
    ),
    // the commands sent to a box as one of the person's calls, and every command for the boxes the account owns
    boxCommands: await rows(
      env,
      `SELECT box_id, callsign, kind, payload, status, result, created_at, sent_at, acked_at FROM box_commands
        WHERE ${by("callsign").sql} OR box_id IN (SELECT box_id FROM boxes WHERE account_id = ?) ORDER BY id`,
      ...by("callsign").binds,
      acct,
    ),
    // what the instance recorded about the person's calls: a move to another instance, a sysop's verification
    accountEvents: await q(
      "SELECT callsign, action, detail, at FROM account_events WHERE $CALLS ORDER BY at",
      "callsign",
    ),
    uiPrefs: await env.DB.prepare("SELECT prefs FROM account_prefs WHERE account_id=?").bind(acct).first(),
    ...(await accountExport(env, scope)),
  };
  return json(data, {
    headers: { "content-disposition": `attachment; filename="aprscaching-${displayCall(cs)}.json"` },
  });
}

/** The held calls of an account, each with its control-verification from the store. */
async function heldCallsExport(env: Env, accountId: string): Promise<Record<string, unknown>[]> {
  const held = (
    await env.DB.prepare("SELECT callsign, is_primary, added_at FROM account_callsigns WHERE account_id=?")
      .bind(accountId)
      .all<{ callsign: string; is_primary: number; added_at: number }>()
  ).results;
  const v = await verificationsOf(
    env,
    held.map((h) => h.callsign),
  );
  return held.map((h) => ({
    callsign: h.callsign,
    verified: v.has(h.callsign) ? 1 : 0,
    method: v.get(h.callsign)?.method ?? null,
    verified_at: v.get(h.callsign)?.verifiedAt ?? null,
    is_primary: h.is_primary,
    added_at: h.added_at,
  }));
}

/** The account-scoped part of the export: every row keyed by the account or any call it holds.
 *  Secrets (passkey public keys, push keys, API key values beyond the owner's own) stay out. */
async function accountExport(
  env: Env,
  { accountId, emails, calls }: Awaited<ReturnType<typeof accountScope>>,
): Promise<Record<string, unknown>> {
  const acct = accountId ?? "";
  const by = (col: string) => personalCall(env, col, calls);
  const q = (sql: string, m: { sql: string; binds: string[] }, ...extra: string[]) =>
    rows(env, sql.replace("$CALLS", m.sql), ...m.binds, ...extra);
  return {
    passkeys: await q(
      "SELECT id, callsign, transports, created_at FROM credentials WHERE $CALLS OR account_id=?",
      by("callsign"),
      acct,
    ),
    callsigns: await heldCallsExport(env, acct),
    callsignHistory: await rows(
      env,
      "SELECT callsign, set_at, verified FROM callsign_history WHERE account_id=? ORDER BY set_at",
      acct,
    ),
    // the claims the person opened to take a call over, and every call that came to or left the account by a
    // claim or a sysop's release
    callsignClaims: await rows(
      env,
      "SELECT callsign, status, method, created_at, completed_at FROM callsign_claims WHERE account_id=? ORDER BY created_at",
      acct,
    ),
    callsignChanges: await rows(
      env,
      `SELECT callsign, action, CASE WHEN to_account=? THEN 'gained' ELSE 'lost' END AS change, actor, note, at
         FROM callsign_events WHERE from_account=? OR to_account=? ORDER BY id`,
      acct,
      acct,
      acct,
    ),
    emailTokens: emails.length
      ? await rows(
          env,
          `SELECT email, callsign, purpose, created_at, used FROM email_tokens WHERE email IN (${emails.map(() => "?").join(",")})`,
          ...emails,
        )
      : [],
    watchCalls: await rows(env, "SELECT callsign, added_at FROM watch_calls WHERE account_id=?", acct),
    verificationChallenges: await rows(
      env,
      "SELECT callsign, method, attempts, created_at FROM callsign_challenges WHERE account_id=?",
      acct,
    ),
    watchAlerts: await rows(
      env,
      "SELECT callsign, kind, detail, cache_id, lat, lon, ts, seen FROM watch_alerts WHERE account_id=? ORDER BY ts",
      acct,
    ),
    savedViews: await q("SELECT slug, name, state, public, created_at FROM saved_views WHERE $CALLS", by("owner_call")),
    pushSubscriptions: await rows(env, "SELECT endpoint, topics, created_at FROM push_subs WHERE account_id=?", acct),
    boxes: await rows(env, "SELECT box_id, created_at FROM boxes WHERE account_id=?", acct),
    enrolledBoxes: await rows(
      env,
      "SELECT box_id, label, callsign, enrolled_at, revoked_at FROM box_keys WHERE enrolled_by=? OR revoked_by=?",
      acct,
      acct,
    ),
    boxEnrollmentCodes: await rows(
      env,
      "SELECT label, callsign, created_at, expires_at, used_at, box_id FROM box_enrollment_codes WHERE created_by=?",
      acct,
    ),
    ratings: await q("SELECT cache_id, callsign, stars, ts FROM cache_ratings WHERE $CALLS", by("callsign")),
    cacheMedia: await q(
      "SELECT m.cache_id, m.kind, m.content_type, m.title, m.bytes, m.created_at FROM cache_media m JOIN caches c ON c.id=m.cache_id WHERE $CALLS",
      by("c.owner_call"),
    ),
    rendezvous: await rows(
      env,
      `SELECT cache_a, cache_b, call_a, call_b, ts, lat, lon FROM rendezvous_log WHERE ${by("call_a").sql} OR ${by("call_b").sql}`,
      ...by("call_a").binds,
      ...by("call_b").binds,
    ),
    entitlements: await rows(env, "SELECT key, granted_at FROM entitlements WHERE account_id=?", acct),
    // the key itself is never stored; its prefix tells the keys apart
    apiKeys: await rows(
      env,
      "SELECT name, prefix, rate_tier, created_at, last_used_at FROM api_keys WHERE account_id=?",
      acct,
    ),
    whitePages: await q("SELECT callsign, home_bbs, updated_at FROM white_pages WHERE $CALLS", by("callsign")),
    bbsMessages: await rows(
      env,
      `SELECT type, from_call, to_call, subject, body, posted_at, read_at FROM bbs_messages WHERE ${by("from_call").sql} OR (type='P' AND ${by("to_call").sql}) ORDER BY posted_at`,
      ...by("from_call").binds,
      ...by("to_call").binds,
    ),
    // the near-cache radio messages sent to any of the person's calls in the last day, kept for their limits
    nearCacheMessages: await q(
      "SELECT call, cache_id, station, msg_no, sent_at, acked_at FROM near_cache_messages WHERE $CALLS ORDER BY sent_at",
      by("call"),
    ),
    // the MeshCom group messages the person sent from any of their calls, as the instance's nodes heard them
    meshcomGroupMessages: await q(
      "SELECT ts, from_call, grp, body, receiver, heard FROM meshcom_group_messages WHERE $CALLS ORDER BY ts",
      by("from_call"),
    ),
    // Mailbox messages the person left, and those addressed to any of their calls
    mailbox: await rows(
      env,
      `SELECT from_call, to_call, body, via, status, delivered_to, created_at, expires_at, delivered_at
         FROM mailbox_messages WHERE from_account=? OR ${by("to_call").sql} ORDER BY created_at`,
      acct,
      ...by("to_call").binds,
    ),
    // adoption requests the person made, and the adoption trail rows naming them (as actor, old or new owner)
    adoptionRequests: await rows(
      env,
      `SELECT cache_id, callsign, in_place, note, status, requested_at, decided_at FROM cache_adoption_requests
        WHERE account_id=? OR ${by("callsign").sql} ORDER BY id`,
      acct,
      ...by("callsign").binds,
    ),
    adoptionLog: await rows(
      env,
      `SELECT cache_id, action, actor_call, from_call, to_call, note, at FROM cache_adoptions
        WHERE ${by("actor_call").sql} OR ${by("from_call").sql} OR ${by("to_call").sql} ORDER BY id`,
      ...by("actor_call").binds,
      ...by("from_call").binds,
      ...by("to_call").binds,
    ),
    stationsOperated: await rows(
      env,
      "SELECT callsign, lat, lon, symbol, description, roles, created_at FROM account_stations WHERE account_id=?",
      acct,
    ),
    // what the sysop did about the person's account and content, a suspension in force, and the reports the
    // person filed. Reports others filed about the person stay with the sysop: they would name the reporter.
    moderationActions: await rows(
      env,
      "SELECT at, action, target_kind, target_label, reason FROM moderation_log WHERE target_account=? ORDER BY id",
      acct,
    ),
    suspension: await env.DB.prepare("SELECT reason, category, until, at FROM account_suspensions WHERE account_id=?")
      .bind(acct)
      .first(),
    reportsFiled: await rows(
      env,
      "SELECT target_kind, target_label, category, text, status, created_at FROM moderation_reports WHERE reporter_account=? ORDER BY id",
      acct,
    ),
    // the tool registries the person added for themselves
    toolRegistries: acct ? await exportAccountRegistries(env, acct) : [],
  };
}

// ----------------------------------------------------- GDPR: erase / anonymise a callsign's data
export async function handleAccountDelete(req: Request, env: Env, named: string): Promise<Response> {
  const callsign = await namedCall(req, env, named);
  const auth = await authorize(env, req, callsign, "delete");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const instance = instanceOf(env, req);
  // Erasure covers the whole person: every base call the account holds, then every account-scoped row.
  const scope = await accountScope(env, cs);
  const calls = [...new Set([cs, ...scope.calls])];
  // The whole erasure is one batch: the anonymisation, the deletions, the federation tombstones and the queue of
  // media objects commit together or not at all. A failed erasure changes nothing and can simply be asked again;
  // one that committed has its tombstones written, and the nightly job finishes any media deletion a crash cut off.
  const stmts: SqlStatement[] = [];
  const tombstoneStmts = new Set<SqlStatement>();
  const mediaKeys: string[] = [];
  for (const c of calls) {
    const erased = await eraseCall(env, instance, c);
    for (const t of erased.tombstones) tombstoneStmts.add(t);
    stmts.push(...erased.tombstones, ...erased.stmts);
    mediaKeys.push(...erased.mediaKeys);
  }
  const suspended = scope.accountId ? await suspensionOf(env, scope.accountId) : null;
  const account = eraseAccount(env, instance, scope.accountId, scope.emails, calls);
  for (const t of account.tombstones) tombstoneStmts.add(t);
  stmts.push(...account.tombstones, ...account.stmts);
  // A suspension outlives the erasure: each base call the account held keeps a minimal record (category and
  // end, no account and no free text) until it ends, so the person cannot come back under the same call. A call
  // that already carries a longer suspension keeps it.
  if (suspended)
    stmts.push(
      ...[...new Set(calls.map((c) => baseCall(c)))].map((c) =>
        env.DB.prepare(
          `INSERT INTO callsign_suspensions (callsign, category, until, at) VALUES (?,?,?,?)
           ON CONFLICT(callsign) DO UPDATE SET
             category = CASE WHEN ${KEEPS_LONGER} THEN callsign_suspensions.category ELSE excluded.category END,
             at = CASE WHEN ${KEEPS_LONGER} THEN callsign_suspensions.at ELSE excluded.at END,
             until = CASE WHEN ${KEEPS_LONGER} THEN callsign_suspensions.until ELSE excluded.until END`,
        ).bind(c, suspended.category, suspended.until, suspended.at),
      ),
    );
  stmts.push(...queueMediaDeletes(env, mediaKeys));
  const results = await env.DB.batch(stmts);
  const tombstones = results.reduce(
    (n, r, i) => n + (tombstoneStmts.has(stmts[i]!) ? Number(r.meta?.changes ?? 0) : 0),
    0,
  );
  // uploaded cache media leaves the object store too; what the store refuses now, the nightly job deletes later
  await finishMediaDeletes(env, mediaKeys);
  return json({ ok: true, erased: cs, tombstones });
}

/** SQL: the suspension a call already carries runs at least as long as the one an erasure brings. */
const KEEPS_LONGER =
  "(callsign_suspensions.until IS NULL OR (excluded.until IS NOT NULL AND callsign_suspensions.until >= excluded.until))";

/**
 * Anonymise and erase one callsign's records, as statements for the erasure's one batch. Its finds, owned caches and
 * messages are rewritten to a withdrawn marker unique to this erasure (`WITHDRAWN#…` — the `#` keeps it
 * unregistrable), so find counts survive and two erased people never collide on a per-caller unique index. The
 * service call shares the sysop's base call but is the instance's own station: its keys, stations and traffic are
 * never the sysop's to erase.
 */
async function eraseCall(
  env: Env,
  instance: string,
  cs: string,
): Promise<{ tombstones: SqlStatement[]; stmts: SqlStatement[]; mediaKeys: string[] }> {
  const marker = `${WITHDRAWN}#${[...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const service = serviceCall(env);
  /** `col` names this call or an SSID of it, and is not the service call. */
  const mine = (col: string) => `((${col}=? OR ${col} LIKE ?) AND ${col} != ?)`;
  const b = [cs, `${cs}-%`, service];
  // media uploaded to the caches this call (or an SSID of it) owns, captured while owner_call still names it
  const media = (
    await env.DB.prepare(
      `SELECT m.id, m.media_key, m.thumb_key FROM cache_media m JOIN caches c ON c.id=m.cache_id WHERE ${mine("c.owner_call")}`,
    )
      .bind(...b)
      .all<{ id: number; media_key: string; thumb_key: string | null }>()
  ).results;
  // the stages' audio clues on those caches: a recording of the owner's voice, so the objects go with them
  const clips = (
    await env.DB.prepare(
      `SELECT s.media_key FROM cache_stages s JOIN caches c ON c.id=s.cache_id WHERE s.media_key IS NOT NULL AND ${mine("c.owner_call")}`,
    )
      .bind(...b)
      .all<{ media_key: string }>()
  ).results;
  // The tombstones come first in the batch, read from the rows the batch then rewrites: once logger_call is the
  // withdrawn marker the finds are no longer found, and peers mirrored them with the real call. The finds feed is
  // append-only by id, so an UPDATE never re-serves the anonymised row; a tombstone is the only way to purge the
  // copies on peers. The same holds for the call's key bindings (an SSID's too) and its move announcements.
  const tombstones = [
    tombstoneSelect(env, instance, "find", "fed_seq", `FROM cache_logs WHERE ${mine("logger_call")}`, ...b),
    tombstoneSelect(env, instance, "key", "fed_seq", `FROM callsign_keys WHERE ${mine("callsign")}`, ...b),
    tombstoneSelect(
      env,
      instance,
      "move",
      "fed_seq",
      "FROM account_moves WHERE callsign=? AND callsign != ?",
      cs,
      service,
    ),
  ];
  const stmts = [
    // A pending later corroboration carries the call in its question: it goes with the person.
    env.DB.prepare(
      `DELETE FROM corroboration_retries WHERE log_id IN (SELECT id FROM cache_logs WHERE ${mine("logger_call")})`,
    ).bind(...b),
    // One found per cache survives anonymisation: a find counts once per person, and two of the
    // person's founds (base call and an SSID) would collide on the one-found-per-logger index once
    // both carry the same marker. The dropped copies are tombstoned with the rest.
    env.DB.prepare(
      `DELETE FROM cache_logs WHERE log_type='found' AND ${mine("logger_call")}
         AND id NOT IN (SELECT MIN(id) FROM cache_logs WHERE log_type='found' AND ${mine("logger_call")}
                        GROUP BY cache_id)`,
    ).bind(...b, ...b),
    env.DB.prepare(
      `UPDATE cache_logs SET logger_call=?, comment=NULL, signer_key=NULL, author_sig=NULL WHERE ${mine("logger_call")}`,
    ).bind(marker, ...b),
    // A station of the person that gated someone else's find is no longer named as its corroborator, nor as the
    // IGate of others' positions, stations and radio commands: the IGate leaderboard and the profile counts follow.
    env.DB.prepare(`UPDATE cache_logs SET corroborator_igate=NULL WHERE ${mine("corroborator_igate")}`).bind(...b),
    env.DB.prepare(`UPDATE positions SET igate_call=NULL WHERE ${mine("igate_call")}`).bind(...b),
    env.DB.prepare(`UPDATE stations SET source_call=NULL WHERE ${mine("source_call")}`).bind(...b),
    env.DB.prepare(`UPDATE radio_commands SET igate_call=NULL WHERE ${mine("igate_call")}`).bind(...b),
    env.DB.prepare(
      `UPDATE cache_stages SET media_key=NULL, media_bytes=NULL WHERE cache_id IN (SELECT id FROM caches WHERE ${mine("owner_call")})`,
    ).bind(...b),
    // archive owned caches AND bump updated_at so the archival re-propagates through the caches feed
    // (peers re-mirror status='archived' → the cache drops off their maps); no cache tombstone needed.
    env.DB.prepare(`UPDATE caches SET owner_call=?, status='archived', updated_at=? WHERE ${mine("owner_call")}`).bind(
      marker,
      nowS(),
      ...b,
    ),
    // The message log names the person as sender or addressee, from the base call or any SSID of it. The text
    // the person wrote is deleted; the row stays under the marker with an empty body, so the other side's
    // conversation shows a withdrawn message rather than a gap. Messages others sent the person are theirs
    // and stay, addressed to the marker. The service call's rows carry the instance's traffic and are left alone.
    env.DB.prepare(`UPDATE messages SET from_call=?, body='' WHERE ${mine("from_call")}`).bind(marker, ...b),
    env.DB.prepare(`UPDATE messages SET to_call=? WHERE ${mine("to_call")}`).bind(marker, ...b),
    // The adoption trail stays for the instance, anonymised: the person's calls become the marker and the
    // notes on rows naming them (which may describe them) are dropped.
    env.DB.prepare(
      `UPDATE cache_adoptions SET note=NULL WHERE ${mine("actor_call")} OR ${mine("from_call")} OR ${mine("to_call")}`,
    ).bind(...b, ...b, ...b),
    ...(["actor_call", "from_call", "to_call"] as const).map((col) =>
      env.DB.prepare(`UPDATE cache_adoptions SET ${col}=? WHERE ${mine(col)}`).bind(marker, ...b),
    ),
    env.DB.prepare(`DELETE FROM cache_adoption_requests WHERE ${mine("callsign")}`).bind(...b),
    ...media.map((m) => env.DB.prepare("DELETE FROM cache_media WHERE id=?").bind(m.id)),
    // the track of every SSID (a tracker on OE8APR-9) and the map's latest state for each of them
    env.DB.prepare(`DELETE FROM positions WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`DELETE FROM stations WHERE ${mine("callsign")}`).bind(...b),
    // What the instance heard of the person's stations: the raw packet ring (as source, or named in a digipeater
    // path), weather readings, MeshCom nodes and links, and the node's heard list.
    env.DB.prepare(
      `DELETE FROM packets_recent WHERE ${mine("callsign")}
          OR (',' || path || ',') LIKE ? OR (',' || path || ',') LIKE ? OR (',' || path || ',') LIKE ?`,
    ).bind(...b, `%,${cs},%`, `%,${cs}*,%`, `%,${cs}-%`),
    env.DB.prepare(`DELETE FROM sensor_readings WHERE ${mine("station")}`).bind(...b),
    env.DB.prepare(`DELETE FROM meshcom_nodes WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`UPDATE meshcom_nodes SET receiver=NULL WHERE ${mine("receiver")}`).bind(...b),
    env.DB.prepare("UPDATE meshcom_nodes SET sent_via=NULL WHERE sent_via LIKE ? OR sent_via LIKE ?").bind(
      `%"${cs}"%`,
      `%"${cs}-%`,
    ),
    env.DB.prepare(`DELETE FROM meshcom_links WHERE ${mine("from_call")} OR ${mine("to_call")}`).bind(...b, ...b),
    env.DB.prepare(`UPDATE meshcom_links SET receiver=NULL WHERE ${mine("receiver")}`).bind(...b),
    env.DB.prepare(`UPDATE meshcom_group_messages SET receiver=NULL WHERE ${mine("receiver")}`).bind(...b),
    env.DB.prepare(`DELETE FROM node_mheard WHERE ${mine("callsign")}`).bind(...b),
    // other accounts' watchlists, and the alerts they raised (with where the person was heard), name the call
    env.DB.prepare(`DELETE FROM watch_alerts WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`DELETE FROM watch_calls WHERE ${mine("callsign")}`).bind(...b),
    // an instance-wide tool registry the person added stays for the instance, no longer naming who added it
    env.DB.prepare(`UPDATE tool_registries SET added_by=? WHERE ${mine("added_by")}`).bind(WITHDRAWN, ...b),
    env.DB.prepare(`DELETE FROM callsign_keys WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare("DELETE FROM account_moves WHERE callsign=? AND callsign != ?").bind(cs, service),
    env.DB.prepare(`DELETE FROM favorites WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`DELETE FROM watches WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`DELETE FROM achievements WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`DELETE FROM stage_unlocks WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare("DELETE FROM callsign_verifications WHERE callsign=?").bind(cs),
    env.DB.prepare(
      "DELETE FROM account_events WHERE callsign=? AND action IN ('sysop_verified', 'sysop_revoked')",
    ).bind(cs),
    env.DB.prepare(`DELETE FROM account_stations WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`DELETE FROM wx_keys WHERE ${mine("callsign")}`).bind(...b),
    env.DB.prepare(`DELETE FROM radio_commands WHERE ${mine("from_call")}`).bind(...b),
    // account-level UI prefs — delete BEFORE the accounts row (the subselect needs account_id)
    env.DB.prepare(
      "DELETE FROM account_prefs WHERE account_id IN (SELECT account_id FROM accounts WHERE callsign=?)",
    ).bind(cs),
    env.DB.prepare("DELETE FROM accounts WHERE callsign=?").bind(cs),
    env.DB.prepare(
      "INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'deleted', NULL, ?)",
    ).bind(cs, nowS()),
  ];
  return {
    tombstones,
    stmts,
    mediaKeys: [
      ...media.flatMap((m) => (m.thumb_key ? [m.media_key, m.thumb_key] : [m.media_key])),
      ...clips.map((c) => c.media_key),
    ],
  };
}

/** Erase every account-scoped row: sign-in material (passkeys, pending ceremonies, email links), the
 *  held calls (freeing each base call), and the person's subscriptions, watches, views, boxes, keys,
 *  ratings, directory entries, personal mail, and every bulletin and queued radio message the person wrote. Returns
 *  the statements for the erasure's one batch, with the tombstones that go before them. */
function eraseAccount(
  env: Env,
  instance: string,
  accountId: string | null,
  emails: string[],
  calls: string[],
): { tombstones: SqlStatement[]; stmts: SqlStatement[] } {
  const service = serviceCall(env);
  const by = (col: string) => {
    const c = anyCall(col, calls);
    // the service call's traffic is the instance's, even though it shares the sysop's base call
    return { sql: `(${c.sql} AND ${col} != ?)`, binds: [...c.binds, service] };
  };
  const del = (sql: string, ...cols: string[]) =>
    env.DB.prepare(cols.reduce((q, col) => q.replace("$CALLS", by(col).sql), sql)).bind(
      ...cols.flatMap((col) => by(col).binds),
    );
  // The person's own bulletins federate, so peers learn of their deletion by a tombstone written before the rows go.
  // A bulletin of theirs mirrored from a peer is suppressed against its origin's id, so a later sync skips it.
  const tombstones = [
    tombstoneSelect(
      env,
      instance,
      "bulletin",
      "id",
      `FROM bbs_messages WHERE type='B' AND origin='local' AND ${by("from_call").sql}`,
      ...by("from_call").binds,
    ),
  ];
  const stmts = [
    env.DB.prepare(
      `INSERT OR REPLACE INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at)
       SELECT bid, origin, 'bulletin', ?, ? FROM bbs_messages
        WHERE type='B' AND origin != 'local' AND bid IS NOT NULL AND ${by("from_call").sql}`,
    ).bind(nowS(), nowS(), ...by("from_call").binds),
    del("DELETE FROM credentials WHERE $CALLS", "callsign"),
    del("DELETE FROM auth_challenges WHERE $CALLS", "callsign"),
    del("DELETE FROM email_tokens WHERE $CALLS", "callsign"),
    del("DELETE FROM saved_views WHERE $CALLS", "owner_call"),
    del("DELETE FROM cache_ratings WHERE $CALLS", "callsign"),
    del("DELETE FROM rendezvous_log WHERE $CALLS OR $CALLS", "call_a", "call_b"),
    del("DELETE FROM white_pages WHERE $CALLS", "callsign"),
    del("DELETE FROM box_commands WHERE $CALLS", "callsign"),
    // a federation batch is kept as personal mail to ACSFED; it is handled with the bulletins below
    del(
      `DELETE FROM bbs_messages WHERE type='P' AND to_call != '${FED_BBS_CATEGORY}' AND ($CALLS OR $CALLS)`,
      "from_call",
      "to_call",
    ),
    del("DELETE FROM mailbox_messages WHERE $CALLS OR $CALLS", "from_call", "to_call"),
    del("DELETE FROM near_cache_messages WHERE $CALLS", "call"),
    del("DELETE FROM meshcom_group_messages WHERE $CALLS", "from_call"),
    ...(accountId ? [env.DB.prepare("DELETE FROM mailbox_messages WHERE from_account=?").bind(accountId)] : []),
    // The bulletins and NTS traffic the person posted go with them; replies others posted stay in the thread.
    // A federation carrier batch holds signed frames, not the person's words, so it stays to be forwarded,
    // attributed to the marker.
    env.DB.prepare(`DELETE FROM bbs_messages WHERE to_call != ? AND ${by("from_call").sql}`).bind(
      FED_BBS_CATEGORY,
      ...by("from_call").binds,
    ),
    env.DB.prepare(`UPDATE bbs_messages SET from_call=? WHERE ${by("from_call").sql}`).bind(
      WITHDRAWN,
      ...by("from_call").binds,
    ),
    // radio messages queued or sent for the person, and those addressed to them (the addressee is the
    // nine-character field that opens an APRS message payload)
    del("DELETE FROM aprs_outbox WHERE $CALLS", "src_call"),
    del("DELETE FROM aprs_outbox WHERE kind='message' AND $CALLS", "rtrim(substr(payload, 2, 9))"),
    // A Mailbox message goes on the air from the service call as `de <call>: <text>`, so the service call's
    // copy in the message log and in the outbox carries the person's words: it goes with them. (The text of an
    // APRS message payload starts at its twelfth character, after `:ADDRESSEE:`.)
    ...calls.flatMap((c) => [
      env.DB.prepare("DELETE FROM messages WHERE from_call=? AND (body LIKE ? OR body LIKE ?)").bind(
        service,
        `de ${c}:%`,
        `de ${c}-%`,
      ),
      env.DB.prepare(
        "DELETE FROM aprs_outbox WHERE upper(src_call)=? AND kind='message' AND (substr(payload, 12) LIKE ? OR substr(payload, 12) LIKE ?)",
      ).bind(service, `de ${c}:%`, `de ${c}-%`),
    ]),
  ];
  for (const e of emails) stmts.push(env.DB.prepare("DELETE FROM email_tokens WHERE email=?").bind(e));
  if (accountId)
    stmts.push(
      // the challenges of the person's claims go with the claims, below
      env.DB.prepare(
        "DELETE FROM callsign_challenges WHERE account_id IN (SELECT 'claim:' || id FROM callsign_claims WHERE account_id=?)",
      ).bind(accountId),
      // the holder-change trail stays for the instance, without the person: their account, and the sysop's note
      // on rows naming it, go
      env.DB.prepare("UPDATE callsign_events SET note=NULL WHERE from_account=? OR to_account=?").bind(
        accountId,
        accountId,
      ),
      env.DB.prepare("UPDATE callsign_events SET from_account=NULL WHERE from_account=?").bind(accountId),
      env.DB.prepare("UPDATE callsign_events SET to_account=NULL WHERE to_account=?").bind(accountId),
      env.DB.prepare("UPDATE callsign_claims SET holder_id=NULL WHERE holder_id=?").bind(accountId),
    );
  if (accountId) stmts.push(...eraseAccountRegistries(env, accountId));
  if (accountId)
    for (const table of [
      "credentials",
      "cache_adoption_requests",
      "account_callsigns",
      "callsign_history",
      "watch_calls",
      "watch_alerts",
      "push_subs",
      "entitlements",
      "api_keys",
      "wx_keys",
      "account_stations",
      "account_prefs",
      "callsign_challenges",
      "callsign_claims",
      "account_suspensions",
      "accounts",
    ])
      stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE account_id=?`).bind(accountId));
  // A report the person filed stays with the sysop without its reporter. The audit log keeps its rows about
  // the person: the instance's legitimate-interest record of what was done and why.
  if (accountId)
    stmts.push(
      env.DB.prepare(
        "UPDATE moderation_reports SET reporter_account=NULL, reporter_call=NULL WHERE reporter_account=?",
      ).bind(accountId),
    );
  if (accountId)
    stmts.push(
      env.DB.prepare("DELETE FROM box_commands WHERE box_id IN (SELECT box_id FROM boxes WHERE account_id=?)").bind(
        accountId,
      ),
      env.DB.prepare("DELETE FROM boxes WHERE account_id=?").bind(accountId),
      // the boxes this account enrolled lose their keys with it, and its codes and revocations are forgotten
      env.DB.prepare("DELETE FROM box_keys WHERE enrolled_by=?").bind(accountId),
      env.DB.prepare("UPDATE box_keys SET revoked_by='erased' WHERE revoked_by=?").bind(accountId),
      env.DB.prepare("DELETE FROM box_enrollment_codes WHERE created_by=?").bind(accountId),
    );
  return { tombstones, stmts };
}

// ----------------------------------------------------- portability: signed migration bundle (source)
export async function handleAccountBundle(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "migrate");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const verified = !!(await verificationOf(env, cs));
  const keys = (await rows(env, "SELECT public_key AS publicKey, label FROM callsign_keys WHERE callsign=?", cs)).map(
    (k) => ({ ...(k as Record<string, unknown>), verified: verified ? 1 : 0 }),
  );
  return json({
    bundle: {
      v: 1,
      instance: instanceOf(env, req),
      callsign: cs,
      verified,
      keys,
      at: nowS(),
    },
  });
}

// ----------------------------------------------------- portability: mark moved (source)
export async function handleAccountMove(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "migrate");
  if (!auth.ok) return auth.res;
  const target = String(auth.body.target ?? "").trim();
  if (!target) return json({ error: "target instance required" }, { status: 400 });
  const cs = callsign.toUpperCase();
  await env.DB.prepare("INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'moved', ?, ?)")
    .bind(cs, target, nowS())
    .run();
  return json({ ok: true, callsign: cs, movedTo: target });
}

// ----------------------------------------------------- portability: import a bundle (target)
export async function handleAccountImport(req: Request, env: Env): Promise<Response> {
  // an import needs no session and opens an account: a handful per client address per hour
  if (await rateLimitedDurable(env, `acct-import:${clientIp(req, env)}`, Date.now(), 5, 3_600_000))
    return json({ error: "rate limited — try again later" }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as {
    bundle?: any;
    assertion?: { key?: string; sig?: string; at?: number };
  };
  const bundle = body.bundle,
    a = body.assertion;
  if (!bundle?.callsign || !Array.isArray(bundle.keys) || !a?.key || !a?.sig || !a?.at)
    return json({ error: "bundle + assertion (key, sig, at) required" }, { status: 400 });
  const cs = String(bundle.callsign).toUpperCase();

  // the mover must prove control of the account: the assertion key must be one of the bundle's keys,
  // signed over an action bound to THIS (target) instance.
  if (!bundle.keys.some((k: any) => k.publicKey === a.key))
    return json({ error: "assertion key is not in the bundle" }, { status: 403 });
  if (Math.abs(nowS() - a.at) > 300) return json({ error: "stale assertion" }, { status: 401 });
  try {
    const key = await importVerifyKey(a.key);
    const msg = new TextEncoder().encode(
      accountActionMessage({ action: "migrate", callsign: cs, instance: instanceOf(env, req), at: a.at }),
    );
    if (!(await crypto.subtle.verify("Ed25519", key, b64urlToBytes(a.sig), msg)))
      return json({ error: "invalid migration assertion" }, { status: 401 });
  } catch {
    return json({ error: "invalid assertion" }, { status: 401 });
  }

  const exists = await env.DB.prepare("SELECT callsign FROM accounts WHERE callsign=?").bind(cs).first();
  if (exists) return json({ error: "callsign already exists here" }, { status: 409 });
  // the imported account holds its base call like every account; a licence held here already is not
  // taken over by an import
  const refused = await unclaimableReason(env, cs);
  if (refused) return json({ error: refused }, { status: refused === "invalid callsign" ? 400 : 409 });
  const base = baseCall(cs);

  // The bundle is CLIENT-supplied and unsigned by any source instance — the device-key
  // assertion only proves the mover controls a key THEY put in the bundle, which says nothing about the
  // callsign. So we must NOT trust `bundle.verified` (that would let anyone import W1AW as "verified").
  // The account + its keys land UNVERIFIED; the operator re-proves control on this instance.
  const accountId = crypto.randomUUID();
  const stmts = [
    ...holdCall(env, accountId, base, true, nowS()),
    env.DB.prepare("INSERT INTO accounts (callsign, account_id, created_at) VALUES (?, ?, ?)").bind(
      cs,
      accountId,
      nowS(),
    ),
    env.DB.prepare(
      "INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'moved', ?, ?)",
    ).bind(cs, `from:${bundle.instance ?? "?"}`, nowS()),
    // announce the move to the network — the target attests "this callsign now homes here",
    // signed at serve time on the account-move feed so peers can re-point attribution.
    // with the mover's signed assertion as its proof, so mirrors can check the move for themselves
    env.DB.prepare(
      "INSERT INTO account_moves (callsign, from_instance, to_instance, ts, proof_key, proof_sig, proof_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(cs, bundle.instance ?? null, instanceOf(env, req), nowS(), a.key, a.sig, a.at),
  ];
  for (const k of bundle.keys)
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO callsign_keys (callsign, public_key, label, created_at) VALUES (?,?,?,?)",
      ).bind(cs, k.publicKey, k.label ?? null, nowS()),
    );
  try {
    await env.DB.batch(stmts);
  } catch {
    return json({ error: "callsign already held here" }, { status: 409 });
  }
  return json({ ok: true, callsign: cs, importedKeys: bundle.keys.length, from: bundle.instance ?? null });
}

// ----------------------------------------------------- federation: account-move feed
interface MoveRow {
  seq: number;
  fed_seq: number;
  callsign: string;
  from_instance: string | null;
  to_instance: string;
  ts: number;
  proof_key: string | null;
  proof_sig: string | null;
  proof_at: number | null;
}
export const ACCOUNT_MOVE_FEED: FeedServeDef<MoveRow> = {
  type: "account-move",
  selectRows: async (env, since, limit) =>
    (
      await env.DB.prepare(
        "SELECT seq, fed_seq, callsign, from_instance, to_instance, ts, proof_key, proof_sig, proof_at FROM account_moves WHERE fed_seq > ? ORDER BY fed_seq LIMIT ?",
      )
        .bind(since, limit)
        .all<MoveRow>()
    ).results,
  recordOf: (r, instance) => ({
    // the global id is the move's place in the moves sequence, which a restored database never hands out again
    id: `${instance}:move:${r.fed_seq}`,
    cursor: r.fed_seq,
    data: {
      callsign: r.callsign,
      fromInstance: r.from_instance,
      toInstance: r.to_instance,
      ts: r.ts,
      ...(r.proof_key && r.proof_sig && r.proof_at != null
        ? { proofKey: r.proof_key, proofSig: r.proof_sig, proofAt: r.proof_at }
        : {}),
    },
  }),
};
export const handleFederationAccountMoves = (req: Request, env: Env): Promise<Response> =>
  serveFeed(req, env, ACCOUNT_MOVE_FEED);
