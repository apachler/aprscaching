// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * moderation.ts — what a public instance needs to answer abuse: players report content, the sysop removes it
 * or suspends the account behind it, and every action lands in an audit log.
 *
 *   POST /api/reports                                   file a report (signed in, or signed out at a lower rate)
 *   GET  /api/admin/moderation/reports?status=          the report queue
 *   POST /api/admin/moderation/reports/:id              resolve or reopen a report
 *   POST /api/admin/moderation/remove                   take down one item {kind, id, reason, reportId?}
 *   POST /api/admin/moderation/restore                  bring a removed cache back {kind: "cache", id, reason}
 *   GET  /api/admin/moderation/accounts?q=              find accounts by callsign or email
 *   GET  /api/admin/moderation/accounts/:call           one account: its state and its content
 *   POST /api/admin/moderation/accounts/:call/suspend   {reason, until?}
 *   POST /api/admin/moderation/accounts/:call/unsuspend {reason}
 *   GET  /api/admin/moderation/log?before=              the audit log, newest first
 *
 * Every admin route passes `requireSysop`; hiding the surface in the web app is a convenience only.
 *
 * How each kind leaves:
 *   - a cache is soft-removed: archived, `removed_at` set, hidden from everyone but its owner and the sysop, and
 *     closed to the owner's edits. The row stays so its finds and adoption trail keep their cache; the sysop
 *     can restore it here, but peers keep it purged.
 *   - a log, a media item and a message (the APRS message log, a BBS post or bulletin, a Mailbox message, a
 *     MeshCom group message) are deleted, along with the media objects.
 *   - a profile loses its self-written fields (name, bio, avatar, links, public contact); the account stays.
 * A removed cache, log or bulletin of this instance emits a signed tombstone, so peers drop their copy. A
 * mirrored bulletin is suppressed against its origin's id, so a later sync does not bring it back.
 */
import { baseCall } from "@aprscaching/aprs";
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json, asStr } from "./app.js";
import { requireSysop, adminCalls, isSysop } from "./admin.js";
import {
  sessionIdentity,
  baseHolder,
  isWithdrawnCall,
  displayCall,
  authThrottled,
  suspensionOf,
  mayActAsOwner,
} from "./auth.js";
import { emitTombstones, type TombstoneItem } from "./tombstones.js";
import { sendEmail } from "./mail.js";
import { pushAlert } from "./notify.js";
import { appBase } from "./sitemap.js";

/** What a report or a removal can name. */
const CONTENT_KINDS = ["cache", "log", "media", "message", "bbs", "mailbox", "meshcom", "profile"] as const;
type ContentKind = (typeof CONTENT_KINDS)[number];
const REPORT_CATEGORIES = ["spam", "offensive", "unsafe", "copyright", "other"] as const;

const REASON_MIN = 3;
const REASON_MAX = 500;
const REPORT_TEXT_MAX = 1000;
/** Signed-in reporters: per account and per address, an hour. Signed-out visitors get a few per address. */
const REPORT_LIMITS = { perIp: 20, perIdentity: 10, windowMs: 3_600_000 };
const ANON_REPORT_LIMITS = { perIp: 3, perIdentity: 0, windowMs: 3_600_000 };
const LIST_MAX = 100;

const isKind = (k: unknown): k is ContentKind => CONTENT_KINDS.includes(k as ContentKind);
const instanceOf = (env: Env, req: Request) => env.INSTANCE ?? new URL(req.url).host;

/** One item as moderation sees it: what it is, who it belongs to, and a line of its text. */
interface Located {
  kind: ContentKind;
  id: string;
  label: string;
  preview: string | null;
  /** The call the content is attributed to; null for an erased owner or content nobody owns. */
  ownerCall: string | null;
  accountId: string | null;
  cacheId: number | null;
  code: string | null;
  at: number | null;
  removed: boolean;
}

const short = (s: string | null | undefined, n = 160): string | null =>
  s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** The account behind a call: the holder of its base call, never for an erased owner's marker. */
async function accountOfCall(env: Env, call: string | null | undefined): Promise<string | null> {
  if (!call || isWithdrawnCall(call)) return null;
  return baseHolder(env, baseCall(call.toUpperCase()));
}

/** Find one item by kind and id, or null when it does not exist (or is already gone). */
async function locate(env: Env, kind: ContentKind, rawId: string): Promise<Located | null> {
  if (kind === "profile") {
    const call = baseCall(rawId.trim().toUpperCase());
    const acct = await baseHolder(env, call);
    if (!acct) return null;
    const p = await env.DB.prepare("SELECT display_name, bio, created_at FROM accounts WHERE account_id=?")
      .bind(acct)
      .first<{ display_name: string | null; bio: string | null; created_at: number }>();
    if (!p) return null;
    return {
      kind,
      id: call,
      label: `profile of ${call}`,
      preview: short([p.display_name, p.bio].filter(Boolean).join(" — ")),
      ownerCall: call,
      accountId: acct,
      cacheId: null,
      code: null,
      at: p.created_at,
      removed: false,
    };
  }
  if (!/^\d{1,12}$/.test(rawId)) return null;
  const id = Number(rawId);
  const base = { kind, id: String(id), cacheId: null, code: null, removed: false } as const;
  switch (kind) {
    case "cache": {
      const c = await env.DB.prepare(
        "SELECT id, code, title, owner_call, description, removed_at, created_at FROM caches WHERE id=?",
      )
        .bind(id)
        .first<{
          id: number;
          code: string;
          title: string;
          owner_call: string;
          description: string | null;
          removed_at: number | null;
          created_at: number;
        }>();
      if (!c) return null;
      return {
        ...base,
        label: `${c.code} ${c.title}`,
        preview: short(c.description),
        ownerCall: isWithdrawnCall(c.owner_call) ? null : c.owner_call,
        accountId: await accountOfCall(env, c.owner_call),
        cacheId: c.id,
        code: c.code,
        at: c.created_at,
        removed: c.removed_at != null,
      };
    }
    case "log": {
      const l = await env.DB.prepare(
        `SELECT l.id, l.cache_id, l.logger_call, l.log_type, l.comment, l.ts, c.code FROM cache_logs l
           LEFT JOIN caches c ON c.id = l.cache_id WHERE l.id=?`,
      )
        .bind(id)
        .first<{
          id: number;
          cache_id: number;
          logger_call: string;
          log_type: string;
          comment: string | null;
          ts: number;
          code: string | null;
        }>();
      if (!l) return null;
      return {
        ...base,
        label: `${l.log_type} by ${displayCall(l.logger_call)} on ${l.code ?? `cache ${l.cache_id}`}`,
        preview: short(l.comment),
        ownerCall: isWithdrawnCall(l.logger_call) ? null : l.logger_call,
        accountId: await accountOfCall(env, l.logger_call),
        cacheId: l.cache_id,
        code: l.code,
        at: l.ts,
      };
    }
    case "media": {
      const m = await env.DB.prepare(
        `SELECT m.id, m.cache_id, m.kind, m.title, m.created_at, c.code, c.owner_call FROM cache_media m
           LEFT JOIN caches c ON c.id = m.cache_id WHERE m.id=?`,
      )
        .bind(id)
        .first<{
          id: number;
          cache_id: number;
          kind: string;
          title: string | null;
          created_at: number;
          code: string | null;
          owner_call: string | null;
        }>();
      if (!m) return null;
      return {
        ...base,
        label: `${m.kind}${m.title ? ` “${m.title}”` : ""} on ${m.code ?? `cache ${m.cache_id}`}`,
        preview: null,
        ownerCall: m.owner_call && !isWithdrawnCall(m.owner_call) ? m.owner_call : null,
        accountId: await accountOfCall(env, m.owner_call),
        cacheId: m.cache_id,
        code: m.code,
        at: m.created_at,
      };
    }
    case "message": {
      const r = await env.DB.prepare("SELECT id, ts, from_call, to_call, body FROM messages WHERE id=?")
        .bind(id)
        .first<{
          id: number;
          ts: number | null;
          from_call: string | null;
          to_call: string | null;
          body: string | null;
        }>();
      if (!r) return null;
      return {
        ...base,
        label: `APRS message ${displayCall(r.from_call ?? "?")} → ${displayCall(r.to_call ?? "?")}`,
        preview: short(r.body),
        ownerCall: r.from_call && !isWithdrawnCall(r.from_call) ? r.from_call : null,
        accountId: await accountOfCall(env, r.from_call),
        at: r.ts,
      };
    }
    case "bbs": {
      const r = await env.DB.prepare(
        "SELECT id, type, from_call, to_call, subject, body, posted_at FROM bbs_messages WHERE id=?",
      )
        .bind(id)
        .first<{
          id: number;
          type: string;
          from_call: string;
          to_call: string;
          subject: string | null;
          body: string;
          posted_at: number;
        }>();
      if (!r) return null;
      return {
        ...base,
        label: `${r.type === "B" ? "bulletin" : "BBS message"} ${displayCall(r.from_call)} → ${r.to_call}${r.subject ? `: ${r.subject}` : ""}`,
        preview: short(r.body),
        ownerCall: isWithdrawnCall(r.from_call) ? null : r.from_call,
        accountId: await accountOfCall(env, r.from_call),
        at: r.posted_at,
      };
    }
    case "mailbox": {
      const r = await env.DB.prepare(
        "SELECT id, from_call, from_account, to_call, body, created_at FROM mailbox_messages WHERE id=?",
      )
        .bind(id)
        .first<{
          id: number;
          from_call: string;
          from_account: string;
          to_call: string;
          body: string;
          created_at: number;
        }>();
      if (!r) return null;
      return {
        ...base,
        label: `Mailbox message ${r.from_call} → ${r.to_call}`,
        preview: short(r.body),
        ownerCall: r.from_call,
        accountId: r.from_account,
        at: r.created_at,
      };
    }
    case "meshcom": {
      const r = await env.DB.prepare("SELECT id, ts, from_call, grp, body FROM meshcom_group_messages WHERE id=?")
        .bind(id)
        .first<{ id: number; ts: number; from_call: string; grp: string; body: string }>();
      if (!r) return null;
      return {
        ...base,
        label: `MeshCom message ${r.from_call} → group ${r.grp}`,
        preview: short(r.body),
        ownerCall: r.from_call,
        accountId: await accountOfCall(env, r.from_call),
        at: r.ts,
      };
    }
  }
  return null;
}

/** Tell an account about an action on its content: in its alert list, by push, and by email when it has one. */
async function notifyAccount(env: Env, accountId: string, subject: string, detail: string, loc?: Located) {
  const acct = await env.DB.prepare("SELECT email FROM accounts WHERE account_id=?")
    .bind(accountId)
    .first<{ email: string | null }>();
  if (!acct) return;
  const mailed = acct.email ? await sendEmail(env, acct.email, subject, `${detail}\n\n${appBase(env)}/\n`) : false;
  // an alert the email already carried is not sent again in the digest
  await env.DB.prepare(
    "INSERT INTO watch_alerts (account_id, callsign, kind, detail, cache_id, ts, notified) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      accountId,
      loc?.code ?? loc?.ownerCall ?? "",
      "moderation",
      detail,
      loc?.cacheId ?? null,
      nowS(),
      mailed ? 1 : 0,
    )
    .run();
  await pushAlert(env, accountId);
}

/** The acting sysop's call for the audit log: the session's call, or OPERATOR for a scripted request. */
async function actorOf(req: Request, env: Env): Promise<string> {
  return (await sessionIdentity(req, env))?.callsign ?? "OPERATOR";
}

function audit(
  env: Env,
  a: {
    actor: string;
    action: string;
    kind: string;
    id: string;
    label?: string | null;
    account?: string | null;
    reason?: string | null;
  },
) {
  return env.DB.prepare(
    `INSERT INTO moderation_log (at, actor_call, action, target_kind, target_id, target_label, target_account, reason)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(nowS(), a.actor, a.action, a.kind, a.id, a.label ?? null, a.account ?? null, a.reason ?? null);
}

/** A sysop's reason: required, a short line. */
function reasonOf(v: unknown): { reason: string } | { error: string } {
  const s = asStr(v).trim();
  if (s.length < REASON_MIN || s.length > REASON_MAX)
    return { error: `a reason of ${REASON_MIN}–${REASON_MAX} characters is required` };
  return { reason: s };
}

// ---------------------------------------------------------------- removal

/** Remove one located item. Returns the tombstones to emit and the media objects to delete. */
async function removeItem(
  env: Env,
  instance: string,
  loc: Located,
  reason: string,
): Promise<{ tombstones: TombstoneItem[]; mediaKeys: string[] }> {
  const id = Number(loc.id);
  const now = nowS();
  switch (loc.kind) {
    case "cache":
      await env.DB.prepare(
        "UPDATE caches SET status='archived', removed_at=?, removed_reason=?, updated_at=? WHERE id=?",
      )
        .bind(now, reason, now, id)
        .run();
      return { tombstones: [{ kind: "cache", targetId: `${instance}:cache:${id}` }], mediaKeys: [] };
    case "log":
      await env.DB.batch([
        env.DB.prepare("DELETE FROM corroboration_retries WHERE log_id=?").bind(id),
        env.DB.prepare("DELETE FROM cache_logs WHERE id=?").bind(id),
      ]);
      return { tombstones: [{ kind: "find", targetId: `${instance}:find:${id}` }], mediaKeys: [] };
    case "media": {
      const m = await env.DB.prepare("SELECT media_key, thumb_key FROM cache_media WHERE id=?")
        .bind(id)
        .first<{ media_key: string; thumb_key: string | null }>();
      await env.DB.prepare("DELETE FROM cache_media WHERE id=?").bind(id).run();
      return { tombstones: [], mediaKeys: m ? [m.media_key, ...(m.thumb_key ? [m.thumb_key] : [])] : [] };
    }
    case "message":
      await env.DB.prepare("DELETE FROM messages WHERE id=?").bind(id).run();
      return { tombstones: [], mediaKeys: [] };
    case "bbs": {
      const b = await env.DB.prepare("SELECT type, bid, origin FROM bbs_messages WHERE id=?")
        .bind(id)
        .first<{ type: string; bid: string | null; origin: string }>();
      const mirrored = !!b && b.origin !== "local" && !!b.bid;
      await env.DB.batch([
        env.DB.prepare("DELETE FROM bbs_messages WHERE id=?").bind(id),
        // a bulletin mirrored from a peer is suppressed against its origin's id, so a later sync skips it
        ...(mirrored
          ? [
              env.DB.prepare(
                "INSERT OR REPLACE INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at) VALUES (?,?,?,?,?)",
              ).bind(b.bid, b.origin, "bulletin", now, now),
            ]
          : []),
      ]);
      const own = !!b && b.type === "B" && b.origin === "local";
      return { tombstones: own ? [{ kind: "bulletin", targetId: `${instance}:bulletin:${id}` }] : [], mediaKeys: [] };
    }
    case "mailbox":
      await env.DB.prepare("DELETE FROM mailbox_messages WHERE id=?").bind(id).run();
      return { tombstones: [], mediaKeys: [] };
    case "meshcom":
      await env.DB.prepare("DELETE FROM meshcom_group_messages WHERE id=?").bind(id).run();
      return { tombstones: [], mediaKeys: [] };
    case "profile":
      await env.DB.prepare(
        "UPDATE accounts SET display_name=NULL, bio=NULL, avatar_url=NULL, links=NULL, public_contact=NULL WHERE account_id=?",
      )
        .bind(loc.accountId)
        .run();
      return { tombstones: [], mediaKeys: [] };
  }
}

/** Settle every open report on an item once it is removed, so the queue does not keep it. */
function resolveReportsOn(env: Env, kind: string, id: string, actor: string, note: string) {
  return env.DB.prepare(
    `UPDATE moderation_reports SET status='resolved', resolution=?, resolved_by=?, resolved_at=?
      WHERE target_kind=? AND target_id=? AND status='open'`,
  ).bind(note, actor, nowS(), kind, id);
}

async function handleRemove(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isKind(b.kind)) return json({ error: `kind must be one of ${CONTENT_KINDS.join(", ")}` }, { status: 400 });
  const r = reasonOf(b.reason);
  if ("error" in r) return json({ error: r.error }, { status: 400 });
  const loc = await locate(env, b.kind, asStr(b.id));
  if (!loc) return json({ error: "no such item — it may already be gone" }, { status: 404 });
  if (loc.removed) return json({ error: "this cache is already removed" }, { status: 409 });
  if (loc.kind === "profile" && loc.accountId && (await accountIsSysop(env, loc.accountId)))
    return json({ error: "an operator's own profile is edited in their settings" }, { status: 409 });
  const actor = await actorOf(req, env);
  const instance = instanceOf(env, req);
  const done = await removeItem(env, instance, loc, r.reason);
  for (const k of done.mediaKeys)
    try {
      await env.MEDIA?.delete?.(k);
    } catch {
      /* the index row is gone either way */
    }
  const tombstones = await emitTombstones(env, instance, done.tombstones);
  await env.DB.batch([
    audit(env, {
      actor,
      action: "remove",
      kind: loc.kind,
      id: loc.id,
      label: loc.label,
      account: loc.accountId,
      reason: r.reason,
    }),
    resolveReportsOn(env, loc.kind, loc.id, actor, `removed: ${r.reason}`),
  ]);
  if (loc.accountId)
    await notifyAccount(
      env,
      loc.accountId,
      "Your content was removed",
      `The sysop removed your ${loc.label}: ${r.reason}`,
      loc,
    );
  return json({ ok: true, kind: loc.kind, id: loc.id, tombstones });
}

async function handleRestore(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (b.kind !== "cache") return json({ error: "only a removed cache can be restored" }, { status: 400 });
  const r = reasonOf(b.reason);
  if ("error" in r) return json({ error: r.error }, { status: 400 });
  const loc = await locate(env, "cache", asStr(b.id));
  if (!loc) return json({ error: "no such cache" }, { status: 404 });
  if (!loc.removed) return json({ error: "this cache is not removed" }, { status: 409 });
  const actor = await actorOf(req, env);
  // back as disabled: its owner checks it and enables it again
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE caches SET status='disabled', removed_at=NULL, removed_reason=NULL, updated_at=? WHERE id=?",
    ).bind(nowS(), Number(loc.id)),
    audit(env, {
      actor,
      action: "restore",
      kind: "cache",
      id: loc.id,
      label: loc.label,
      account: loc.accountId,
      reason: r.reason,
    }),
  ]);
  if (loc.accountId)
    await notifyAccount(
      env,
      loc.accountId,
      "Your cache was restored",
      `The sysop restored ${loc.label} (${r.reason}). It is disabled until you enable it again.`,
      loc,
    );
  return json({ ok: true });
}

/**
 * A removed cache, to everyone but its owner and the sysop: the 410 to answer with, or null to go on. Its
 * detail, logbook, gallery and stages all ask here.
 */
export async function removedCacheResponse(req: Request, env: Env, cacheId: number): Promise<Response | null> {
  const c = await env.DB.prepare("SELECT owner_call, removed_at FROM caches WHERE id=?")
    .bind(cacheId)
    .first<{ owner_call: string; removed_at: number | null }>();
  if (!c || c.removed_at == null) return null;
  if ((await mayActAsOwner(req, env, c.owner_call)) || (await isSysop(req, env))) return null;
  return json({ error: "this cache was removed by the instance operator" }, { status: 410 });
}

// ---------------------------------------------------------------- suspension

/** Is a call held by a suspended account? The ingest plane asks before it logs, posts or sends for a call. */
export async function callSuspended(env: Env, call: string): Promise<boolean> {
  const acct = await accountOfCall(env, call);
  return !!acct && !!(await suspensionOf(env, acct));
}

/** The text a refused write over the radio or the ingest plane carries. */
export const SUSPENDED_TEXT = "this account is suspended on this instance";

async function heldCalls(env: Env, accountId: string): Promise<string[]> {
  return (
    await env.DB.prepare("SELECT callsign FROM account_callsigns WHERE account_id=? ORDER BY is_primary DESC, callsign")
      .bind(accountId)
      .all<{ callsign: string }>()
  ).results.map((r) => r.callsign);
}

/** Does the account hold a call named in ADMIN_CALLSIGNS? Such an account is never suspended from here. */
async function accountIsSysop(env: Env, accountId: string): Promise<boolean> {
  const admins = adminCalls(env);
  return (await heldCalls(env, accountId)).some((c) => admins.has(c));
}

async function handleSuspend(req: Request, env: Env, call: string, lift: boolean): Promise<Response> {
  const label = baseCall(call.toUpperCase());
  const acct = await baseHolder(env, label);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = reasonOf(b.reason);
  if ("error" in r) return json({ error: r.error }, { status: 400 });
  const actor = await actorOf(req, env);
  // the suspension of an erased account lives on its calls: lifting it frees the call for a new account
  if (!acct && lift) {
    const had = await env.DB.prepare("DELETE FROM callsign_suspensions WHERE callsign=? RETURNING callsign")
      .bind(label)
      .first();
    if (!had) return json({ error: "this callsign is not suspended" }, { status: 409 });
    await audit(env, { actor, action: "unsuspend", kind: "callsign", id: label, label, reason: r.reason }).run();
    return json({ ok: true, suspended: null });
  }
  if (!acct) return json({ error: "no account holds this callsign" }, { status: 404 });
  if (lift) {
    const had = await env.DB.prepare("DELETE FROM account_suspensions WHERE account_id=? RETURNING account_id")
      .bind(acct)
      .first();
    if (!had) return json({ error: "this account is not suspended" }, { status: 409 });
    await audit(env, {
      actor,
      action: "unsuspend",
      kind: "account",
      id: label,
      label,
      account: acct,
      reason: r.reason,
    }).run();
    await notifyAccount(env, acct, "Your account is active again", `The sysop lifted the suspension: ${r.reason}`);
    return json({ ok: true, suspended: null });
  }
  if (await accountIsSysop(env, acct))
    return json({ error: "an operator's account cannot be suspended here" }, { status: 409 });
  const until = b.until == null || b.until === "" ? null : Number(b.until);
  if (until !== null && (!Number.isInteger(until) || until <= nowS()))
    return json({ error: "until must be a future time in unix seconds, or empty" }, { status: 400 });
  // the category is all of the suspension that outlives an erasure of the account, so it is required
  const category = REPORT_CATEGORIES.find((c) => c === b.category);
  if (!category) return json({ error: `category must be one of ${REPORT_CATEGORIES.join(", ")}` }, { status: 400 });
  const now = nowS();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO account_suspensions (account_id, reason, category, until, by_call, at) VALUES (?,?,?,?,?,?)",
    ).bind(acct, r.reason, category, until, actor, now),
    // every session the account holds ends now
    env.DB.prepare("UPDATE accounts SET session_gen = session_gen + 1 WHERE account_id=?").bind(acct),
    audit(env, {
      actor,
      action: "suspend",
      kind: "account",
      id: label,
      label,
      account: acct,
      reason: `${category}: ${r.reason}${until ? ` (until ${new Date(until * 1000).toISOString().slice(0, 10)})` : ""}`,
    }),
  ]);
  const untilText = until ? ` until ${new Date(until * 1000).toISOString().slice(0, 10)}` : "";
  await notifyAccount(
    env,
    acct,
    "Your account is suspended",
    `The sysop suspended your account${untilText}: ${r.reason}`,
  );
  return json({ ok: true, suspended: { reason: r.reason, category, until, at: now } });
}

// ---------------------------------------------------------------- accounts

interface AccountRow {
  account_id: string;
  callsign: string;
  email: string | null;
  created_at: number;
}

async function accountSummary(env: Env, a: AccountRow) {
  const s = await suspensionOf(env, a.account_id);
  return {
    callsign: a.callsign,
    calls: await heldCalls(env, a.account_id),
    email: a.email,
    createdAt: a.created_at,
    suspended: s ? { reason: s.reason, category: s.category, until: s.until, at: s.at } : null,
    operator: await accountIsSysop(env, a.account_id),
  };
}

async function handleAccountSearch(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  const suspendedOnly = new URL(req.url).searchParams.get("suspended") === "1";
  let rows: AccountRow[];
  if (suspendedOnly) {
    rows = (
      await env.DB.prepare(
        `SELECT a.account_id, a.callsign, a.email, a.created_at FROM accounts a
           JOIN account_suspensions s ON s.account_id = a.account_id ORDER BY s.at DESC LIMIT 50`,
      ).all<AccountRow>()
    ).results;
  } else if (q.length < 2) {
    return json({ error: "type at least two characters of a callsign or an email address" }, { status: 400 });
  } else if (q.includes("@")) {
    rows = (
      await env.DB.prepare(
        "SELECT account_id, callsign, email, created_at FROM accounts WHERE lower(email) LIKE ? ORDER BY callsign LIMIT 20",
      )
        .bind(`%${q.toLowerCase().replace(/[%_]/g, "")}%`)
        .all<AccountRow>()
    ).results;
  } else {
    rows = (
      await env.DB.prepare(
        `SELECT a.account_id, a.callsign, a.email, a.created_at FROM accounts a
          WHERE a.account_id IN (SELECT account_id FROM account_callsigns WHERE callsign LIKE ?)
          ORDER BY a.callsign LIMIT 20`,
      )
        .bind(`${baseCall(q.toUpperCase()).replace(/[%_]/g, "")}%`)
        .all<AccountRow>()
    ).results;
  }
  const accounts = await Promise.all(rows.map((r) => accountSummary(env, r)));
  // the suspended list also names the calls whose account was erased while suspended: no account, only the
  // call, the category and the end
  const erased = suspendedOnly
    ? (
        await env.DB.prepare(
          `SELECT callsign, category, until, at FROM callsign_suspensions
            WHERE until IS NULL OR until > ? ORDER BY at DESC LIMIT 50`,
        )
          .bind(nowS())
          .all<{ callsign: string; category: string; until: number | null; at: number }>()
      ).results
    : [];
  return json({ accounts, erasedCalls: erased });
}

/** `col` names one of `calls` or an SSID of it. */
function anyCall(col: string, calls: string[]): { sql: string; binds: string[] } {
  return {
    sql: `(${calls.map(() => `${col}=? OR ${col} LIKE ?`).join(" OR ")})`,
    binds: calls.flatMap((c) => [c, `${c}-%`]),
  };
}

/** One account for the sysop: its state, its recent content in every kind, and what was done about it. */
async function handleAccountDetail(env: Env, call: string): Promise<Response> {
  const acct = await baseHolder(env, baseCall(call.toUpperCase()));
  if (!acct) return json({ error: "no account holds this callsign" }, { status: 404 });
  const a = await env.DB.prepare("SELECT account_id, callsign, email, created_at FROM accounts WHERE account_id=?")
    .bind(acct)
    .first<AccountRow>();
  if (!a) return json({ error: "no account holds this callsign" }, { status: 404 });
  const calls = await heldCalls(env, acct);
  const by = (col: string) => anyCall(col, calls);
  const list = async <T>(sql: string, ...binds: unknown[]) =>
    (
      await env.DB.prepare(sql)
        .bind(...binds)
        .all<T>()
    ).results;
  const item = (
    kind: ContentKind,
    id: number,
    label: string,
    preview: string | null,
    at: number | null,
    extra = {},
  ) => ({
    kind,
    id: String(id),
    label,
    preview: short(preview),
    at,
    ...extra,
  });
  const caches = await list<{
    id: number;
    code: string;
    title: string;
    status: string;
    removed_at: number | null;
    created_at: number;
  }>(
    `SELECT id, code, title, status, removed_at, created_at FROM caches WHERE ${by("owner_call").sql} ORDER BY created_at DESC LIMIT 50`,
    ...by("owner_call").binds,
  );
  const logs = await list<{
    id: number;
    cache_id: number;
    log_type: string;
    comment: string | null;
    ts: number;
    code: string | null;
  }>(
    `SELECT l.id, l.cache_id, l.log_type, l.comment, l.ts, c.code FROM cache_logs l LEFT JOIN caches c ON c.id=l.cache_id
      WHERE ${by("l.logger_call").sql} ORDER BY l.ts DESC LIMIT 50`,
    ...by("l.logger_call").binds,
  );
  const media = await list<{
    id: number;
    cache_id: number;
    kind: string;
    title: string | null;
    created_at: number;
    code: string;
  }>(
    `SELECT m.id, m.cache_id, m.kind, m.title, m.created_at, c.code FROM cache_media m JOIN caches c ON c.id=m.cache_id
      WHERE ${by("c.owner_call").sql} ORDER BY m.created_at DESC LIMIT 50`,
    ...by("c.owner_call").binds,
  );
  const messages = await list<{ id: number; ts: number | null; to_call: string | null; body: string | null }>(
    `SELECT id, ts, to_call, body FROM messages WHERE ${by("from_call").sql} ORDER BY ts DESC LIMIT 50`,
    ...by("from_call").binds,
  );
  const bbs = await list<{
    id: number;
    type: string;
    to_call: string;
    subject: string | null;
    body: string;
    posted_at: number;
  }>(
    `SELECT id, type, to_call, subject, body, posted_at FROM bbs_messages WHERE ${by("from_call").sql} ORDER BY posted_at DESC LIMIT 50`,
    ...by("from_call").binds,
  );
  const mailbox = await list<{ id: number; to_call: string; body: string; created_at: number }>(
    "SELECT id, to_call, body, created_at FROM mailbox_messages WHERE from_account=? ORDER BY created_at DESC LIMIT 50",
    acct,
  );
  const meshcom = await list<{ id: number; ts: number; grp: string; body: string }>(
    `SELECT id, ts, grp, body FROM meshcom_group_messages WHERE ${by("from_call").sql} ORDER BY ts DESC LIMIT 50`,
    ...by("from_call").binds,
  );
  const actions = await list<LogRow>(
    "SELECT * FROM moderation_log WHERE target_account=? ORDER BY id DESC LIMIT 50",
    acct,
  );
  const openReports = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM moderation_reports WHERE target_account=? AND status='open'",
  )
    .bind(acct)
    .first<{ n: number }>();
  return json({
    account: await accountSummary(env, a),
    openReports: openReports?.n ?? 0,
    content: [
      ...caches.map((c) =>
        item("cache", c.id, `${c.code} ${c.title}`, null, c.created_at, {
          cacheId: c.id,
          code: c.code,
          status: c.status,
          removed: c.removed_at != null,
        }),
      ),
      ...logs.map((l) =>
        item("log", l.id, `${l.log_type} on ${l.code ?? `cache ${l.cache_id}`}`, l.comment, l.ts, {
          cacheId: l.cache_id,
          code: l.code,
        }),
      ),
      ...media.map((m) =>
        item("media", m.id, `${m.kind}${m.title ? ` “${m.title}”` : ""} on ${m.code}`, null, m.created_at, {
          cacheId: m.cache_id,
          code: m.code,
        }),
      ),
      ...messages.map((m) => item("message", m.id, `APRS message → ${m.to_call ?? "?"}`, m.body, m.ts)),
      ...bbs.map((m) =>
        item(
          "bbs",
          m.id,
          `${m.type === "B" ? "bulletin" : "BBS message"} → ${m.to_call}${m.subject ? `: ${m.subject}` : ""}`,
          m.body,
          m.posted_at,
        ),
      ),
      ...mailbox.map((m) => item("mailbox", m.id, `Mailbox message → ${m.to_call}`, m.body, m.created_at)),
      ...meshcom.map((m) => item("meshcom", m.id, `MeshCom message → group ${m.grp}`, m.body, m.ts)),
    ],
    actions: actions.map(logView),
  });
}

// ---------------------------------------------------------------- reports

/** POST /api/reports {kind, id, category, text} — report an item to the sysop. */
export async function handleReport(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isKind(b.kind)) return json({ error: `kind must be one of ${CONTENT_KINDS.join(", ")}` }, { status: 400 });
  const category = REPORT_CATEGORIES.find((c) => c === b.category);
  if (!category) return json({ error: `category must be one of ${REPORT_CATEGORIES.join(", ")}` }, { status: 400 });
  const text = asStr(b.text).trim();
  if (text.length > REPORT_TEXT_MAX)
    return json({ error: `say it in at most ${REPORT_TEXT_MAX} characters` }, { status: 400 });
  if (category === "other" && text.length < REASON_MIN)
    return json({ error: "say what is wrong with it" }, { status: 400 });
  const me = await sessionIdentity(req, env);
  const limited = me
    ? await authThrottled(env, req, "report", me.accountId, REPORT_LIMITS)
    : await authThrottled(env, req, "report-anon", "", ANON_REPORT_LIMITS);
  if (limited) return limited;
  const loc = await locate(env, b.kind, asStr(b.id));
  if (!loc || loc.removed) return json({ error: "no such item — it may already be gone" }, { status: 404 });
  // one open report per reporter and item: a second tap changes nothing
  if (me) {
    const prior = await env.DB.prepare(
      "SELECT id FROM moderation_reports WHERE reporter_account=? AND target_kind=? AND target_id=? AND status='open'",
    )
      .bind(me.accountId, loc.kind, loc.id)
      .first<{ id: number }>();
    if (prior) return json({ ok: true, id: prior.id, duplicate: true });
  }
  const r = await env.DB.prepare(
    `INSERT INTO moderation_reports (target_kind, target_id, target_label, target_account, category, text,
       reporter_account, reporter_call, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      loc.kind,
      loc.id,
      loc.label,
      loc.accountId,
      category,
      text || null,
      me?.accountId ?? null,
      me?.callsign ?? null,
      nowS(),
    )
    .run();
  const id = Number(r.meta?.last_row_id);
  const to = env.OPERATOR_EMAIL?.trim();
  if (to)
    await sendEmail(
      env,
      to,
      `Report on ${instanceOf(env, req)}: ${category} — ${loc.label}`,
      [
        `A ${category} report on ${loc.label}${me ? ` from ${me.callsign}` : " from a signed-out visitor"}.`,
        text ? `\n${text}\n` : "",
        `Open Instance admin → Moderation → Reports: ${appBase(env)}/`,
      ].join("\n"),
    );
  return json({ ok: true, id }, { status: 201 });
}

interface ReportRow {
  id: number;
  target_kind: string;
  target_id: string;
  target_label: string | null;
  category: string;
  text: string | null;
  reporter_call: string | null;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
}

async function handleReportList(req: Request, env: Env): Promise<Response> {
  const want = new URL(req.url).searchParams.get("status") === "resolved" ? "resolved" : "open";
  const rows = (
    await env.DB.prepare("SELECT * FROM moderation_reports WHERE status=? ORDER BY id DESC LIMIT ?")
      .bind(want, LIST_MAX)
      .all<ReportRow>()
  ).results;
  const counts = (
    await env.DB.prepare("SELECT status, COUNT(*) AS n FROM moderation_reports GROUP BY status").all<{
      status: string;
      n: number;
    }>()
  ).results;
  const reports = await Promise.all(
    rows.map(async (r) => {
      const loc = isKind(r.target_kind) ? await locate(env, r.target_kind, r.target_id) : null;
      return {
        id: r.id,
        kind: r.target_kind,
        targetId: r.target_id,
        label: loc?.label ?? r.target_label,
        preview: loc?.preview ?? null,
        ownerCall: loc?.ownerCall ? displayCall(loc.ownerCall) : null,
        cacheId: loc?.cacheId ?? null,
        code: loc?.code ?? null,
        gone: !loc || loc.removed,
        category: r.category,
        text: r.text,
        reporter: r.reporter_call,
        status: r.status,
        resolution: r.resolution,
        resolvedBy: r.resolved_by,
        resolvedAt: r.resolved_at,
        createdAt: r.created_at,
      };
    }),
  );
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  return json({ reports, counts: { open: n("open"), resolved: n("resolved") } });
}

async function handleReportDecision(req: Request, env: Env, id: number): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = b.status === "open" ? "open" : b.status === "resolved" ? "resolved" : null;
  if (!status) return json({ error: "status must be resolved or open" }, { status: 400 });
  const note = asStr(b.note).trim().slice(0, REASON_MAX) || null;
  const row = await env.DB.prepare(
    "SELECT target_kind, target_id, target_label, target_account FROM moderation_reports WHERE id=?",
  )
    .bind(id)
    .first<{ target_kind: string; target_id: string; target_label: string | null; target_account: string | null }>();
  if (!row) return json({ error: "no such report" }, { status: 404 });
  const actor = await actorOf(req, env);
  await env.DB.batch([
    status === "resolved"
      ? env.DB.prepare(
          "UPDATE moderation_reports SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE id=?",
        ).bind(note ?? "no action", actor, nowS(), id)
      : env.DB.prepare(
          "UPDATE moderation_reports SET status='open', resolution=NULL, resolved_by=NULL, resolved_at=NULL WHERE id=?",
        ).bind(id),
    audit(env, {
      actor,
      action: status === "resolved" ? "resolve" : "reopen",
      kind: "report",
      id: String(id),
      label: `${row.target_kind} ${row.target_label ?? row.target_id}`,
      account: row.target_account,
      reason: note,
    }),
  ]);
  return json({ ok: true, status });
}

// ---------------------------------------------------------------- audit log

interface LogRow {
  id: number;
  at: number;
  actor_call: string;
  action: string;
  target_kind: string;
  target_id: string;
  target_label: string | null;
  reason: string | null;
}
const logView = (r: LogRow) => ({
  id: r.id,
  at: r.at,
  actor: r.actor_call,
  action: r.action,
  kind: r.target_kind,
  targetId: r.target_id,
  label: r.target_label,
  reason: r.reason,
});

async function handleAuditLog(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const before = Number(u.searchParams.get("before") ?? 0);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 50) || 50, 1), LIST_MAX);
  const rows = (
    await env.DB.prepare(`SELECT * FROM moderation_log ${before > 0 ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...(before > 0 ? [before] : []), limit + 1)
      .all<LogRow>()
  ).results;
  const page = rows.slice(0, limit);
  return json({
    entries: page.map(logView),
    nextBefore: rows.length > limit ? page[page.length - 1]!.id : null,
  });
}

// ---------------------------------------------------------------- the admin router

/** /api/admin/moderation/* — every route here is the sysop's (or the operator secret's) alone. */
export async function handleAdminModeration(req: Request, env: Env, rest: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const m = req.method;
  if (rest === "/reports" && m === "GET") return handleReportList(req, env);
  const rep = /^\/reports\/(\d+)$/.exec(rest);
  if (rep && m === "POST") return handleReportDecision(req, env, Number(rep[1]));
  if (rest === "/remove" && m === "POST") return handleRemove(req, env);
  if (rest === "/restore" && m === "POST") return handleRestore(req, env);
  if (rest === "/accounts" && m === "GET") return handleAccountSearch(req, env);
  const acct = /^\/accounts\/([A-Za-z0-9-]{3,12})(\/suspend|\/unsuspend)?$/.exec(rest);
  if (acct && !acct[2] && m === "GET") return handleAccountDetail(env, acct[1]!);
  if (acct && acct[2] && m === "POST") return handleSuspend(req, env, acct[1]!, acct[2] === "/unsuspend");
  if (rest === "/log" && m === "GET") return handleAuditLog(req, env);
  return new Response("not found", { status: 404 });
}
