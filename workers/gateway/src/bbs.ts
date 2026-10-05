// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import { ingestSecretOk, ingestOrServiceBoxOk, sessionIdentity, accountHoldsCall } from "./auth.js";
/**
 * bbs.ts — the BBS message base: personal mail, bulletins and NTS traffic, moved the F6FBB way only. A
 * station reads and writes it over a connected-mode session (the packet BBS on the ingest box), partner BBSes
 * exchange it by FBB forwarding, and the app reads and writes it as a terminal would. It never sends over
 * APRS or MeshCom: holding a message for a station until it is heard on air is the Mailbox's job. BID + P/B/T
 * typing are MBL/FBB-compatible so the connected-mode gateway bridges to real F6FBB/BPQ32 nodes.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import type { FeedServeDef } from "./federation.js";
import { FED_BBS_CATEGORY } from "@aprscaching/shared";
import { baseCall } from "@aprscaching/aprs";
import { serviceCall, FALLBACK_SERVICE_CALL } from "./servicecall.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { callSuspended, SUSPENDED_TEXT } from "./moderation.js";

const BULLETIN_TO = /^(ALL|SYSOP|BLN|NWS|SKY)/i;

/** How long a bulletin stays when its poster or the BBS it came from named no lifetime. */
export const BULLETIN_LIFETIME_SEC = 30 * 86400;

// ---------------------------------------------------------------- BIDs
/** An FBB BID holds at most 12 characters: F6FBB defers (`FS =`) a proposal with a longer one. */
const BID_MAX = 12;

/** The call this BBS's BIDs carry: the sysop's base call, the base of the service call. */
export const bbsCall = (env: Env): string => baseCall(serviceCall(env));

/**
 * The BID of local message `id`, `<id in base 36>_<call>`, the `<number>_<BBS call>` form F6FBB issues. The
 * number takes the digits the call leaves within 12 characters (five beside a six-character call, so 36^5
 * messages before it wraps). Pure.
 */
export function bidFor(id: number, call: string): string {
  const digits = BID_MAX - 1 - call.length;
  return `${(id % 36 ** digits).toString(36).toUpperCase()}_${call}`;
}

/**
 * Does `bid` carry this BBS's call? Only this BBS issues those, so one arriving from elsewhere is refused. An
 * instance without a sysop call shares the fallback call with every other such instance, so it owns none.
 */
export function isOwnBid(env: Env, bid: string): boolean {
  const call = bbsCall(env);
  return call !== FALLBACK_SERVICE_CALL && bid.toUpperCase().endsWith(`_${call}`);
}

// ---------------------------------------------------------------- mailbox access
/** The callsign a mailbox address names: `OE1TST @ OE1BBB.OE.EU` → `OE1TST`. */
const mailboxCall = (addr: string): string => (addr.split("@")[0] ?? "").trim().toUpperCase();

/**
 * May the caller act for `call`'s mailbox? The ingest box may, on the shared secret or as an enrolled box the
 * sysop lets run this instance's services (it carries mail for every station it hears
 * and forwards, and its FBB scheduler delivers inbound mail); a signed-in session may when its account holds
 * the call's base call. Anyone else reading or writing a callsign's personal mail would be reading another
 * operator's mail or posting in their name. Returns the response to send, or null to proceed.
 */
async function requireMailbox(req: Request, env: Env, call: string): Promise<Response | null> {
  if (ingestOrServiceBoxOk(req, env)) return null;
  if (req.headers.get("x-ingest-secret") !== null) return new Response("unauthorized", { status: 401 });
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to use the BBS" }, { status: 401 });
  if (!(await accountHoldsCall(env, me.accountId, mailboxCall(call))))
    return json({ error: "this mailbox belongs to a callsign your account does not hold" }, { status: 403 });
  return null;
}

// ---------------------------------------------------------------- post
/** The largest message body, in UTF-8 bytes: a long FBB message, and still a small row to forward. */
export const BBS_BODY_MAX_BYTES = 64 * 1024;
/** The longest subject: FBB carries a title of at most 80 characters. */
export const BBS_SUBJECT_MAX = 80;
/** The longest lifetime a poster may set; a bulletin with none lives this long too. */
export const BBS_LIFETIME_MAX_SEC = 30 * 86400;
/** Messages one account (or, through the ingest box, one base call) may post a day. */
export const BBS_POSTS_PER_DAY = 20;

export async function handleBbsPost(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b !== "object" || b === null || Array.isArray(b))
    return json({ error: "fromCall, toCall, body required" }, { status: 400 });
  const { fromCall, toCall, body, subject, lifetimeSec } = b;
  if (typeof fromCall !== "string" || typeof toCall !== "string" || typeof body !== "string")
    return json({ error: "fromCall, toCall, body required" }, { status: 400 });
  if (!fromCall.trim() || !toCall.trim() || !body)
    return json({ error: "fromCall, toCall, body required" }, { status: 400 });
  if (subject != null && typeof subject !== "string") return json({ error: "subject must be text" }, { status: 400 });
  if (lifetimeSec != null && !(typeof lifetimeSec === "number" && Number.isInteger(lifetimeSec) && lifetimeSec > 0))
    return json({ error: "lifetimeSec must be a positive whole number of seconds" }, { status: 400 });
  const replyToId = typeof b.replyTo === "number" && Number.isInteger(b.replyTo) ? b.replyTo : null;
  // a message is sent in its sender's name, so only the sender's mailbox may post it
  const denied = await requireMailbox(req, env, fromCall);
  if (denied) return denied;
  // the ingest box posts for the stations it hears: a suspended account's call posts nothing
  if (await callSuspended(env, fromCall)) return json({ error: SUSPENDED_TEXT }, { status: 403 });
  if (new TextEncoder().encode(body).length > BBS_BODY_MAX_BYTES)
    return json({ error: `the message is longer than ${BBS_BODY_MAX_BYTES / 1024} KB` }, { status: 413 });
  if (subject && subject.length > BBS_SUBJECT_MAX)
    return json({ error: `the subject is longer than ${BBS_SUBJECT_MAX} characters` }, { status: 400 });
  if (lifetimeSec != null && lifetimeSec > BBS_LIFETIME_MAX_SEC)
    return json({ error: `a message lives at most ${BBS_LIFETIME_MAX_SEC / 86400} days` }, { status: 400 });
  const from = fromCall.toUpperCase(),
    to = toCall.toUpperCase();
  // The ingest box posts for the stations it hears, so its budget is per sender; a session's is per account.
  const me = ingestSecretOk(req, env) ? null : await sessionIdentity(req, env);
  const rateKey = me ? `bbs-post:acct:${me.accountId}` : `bbs-post:call:${baseCall(mailboxCall(from))}`;
  if (await rateLimitedDurable(env, rateKey, Date.now(), BBS_POSTS_PER_DAY, 86_400_000))
    return json({ error: `at most ${BBS_POSTS_PER_DAY} messages a day` }, { status: 429 });
  const type = b.type === "B" || b.type === "P" || b.type === "T" ? b.type : BULLETIN_TO.test(to) ? "B" : "P";
  const posted = nowS();
  const expires = lifetimeSec != null ? posted + lifetimeSec : type === "B" ? posted + BULLETIN_LIFETIME_SEC : null;

  // Reply: inherit the parent's conversation root so replies chain into a thread
  let replyTo: number | null = null,
    threadRoot: number | null = null;
  if (replyToId) {
    const parent = await env.DB.prepare("SELECT id, thread_id FROM bbs_messages WHERE id=?")
      .bind(replyToId)
      .first<{ id: number; thread_id: number | null }>();
    if (parent) {
      replyTo = parent.id;
      threadRoot = parent.thread_id ?? parent.id;
    }
  }

  const res = await env.DB.prepare(
    "INSERT INTO bbs_messages (type, from_call, to_call, subject, body, posted_at, expires_at, origin, reply_to) VALUES (?,?,?,?,?,?,?, 'local', ?)",
  )
    .bind(type, from, to, subject || null, body, posted, expires, replyTo)
    .run();
  const id = Number(res.meta.last_row_id);
  const bid = bidFor(id, bbsCall(env));
  // a root message threads to itself; a reply keeps the parent's root
  await env.DB.prepare("UPDATE bbs_messages SET bid=?, thread_id=? WHERE id=?")
    .bind(bid, threadRoot ?? id, id)
    .run();

  return json({ ok: true, id, bid, type, threadId: threadRoot ?? id, replyTo }, { status: 201 });
}

/** GET /api/bbs/thread/:id — a conversation (root + all replies), oldest first. */
export async function handleBbsThread(req: Request, env: Env, id: number): Promise<Response> {
  const root = await env.DB.prepare("SELECT thread_id FROM bbs_messages WHERE id=?")
    .bind(id)
    .first<{ thread_id: number | null }>();
  const threadId = root?.thread_id ?? id;
  const msgs = (
    await env.DB.prepare("SELECT * FROM bbs_messages WHERE thread_id=? OR id=? ORDER BY posted_at ASC LIMIT 200")
      .bind(threadId, threadId)
      .all<{ type: string; from_call: string; to_call: string }>()
  ).results;
  // Bulletins are public; personal mail in a thread shows only to the ingest box and to the parties.
  const me = ingestSecretOk(req, env) ? null : await sessionIdentity(req, env);
  const held = new Map<string, boolean>();
  const holds = async (addr: string): Promise<boolean> => {
    const cs = mailboxCall(addr);
    if (!held.has(cs)) held.set(cs, !!me && (await accountHoldsCall(env, me.accountId, cs)));
    return held.get(cs)!;
  };
  const visible = [];
  for (const m of msgs)
    if (ingestSecretOk(req, env) || m.type === "B" || (await holds(m.from_call)) || (await holds(m.to_call)))
      visible.push(m);
  return json({ threadId, messages: visible.map(row) });
}

// ---------------------------------------------------------------- read views
function row(m: any) {
  return {
    id: m.id,
    bid: m.bid,
    type: m.type,
    fromCall: m.from_call,
    toCall: m.to_call,
    subject: m.subject,
    body: m.body,
    postedAt: m.posted_at,
    origin: m.origin,
    readAt: m.read_at,
    replyTo: m.reply_to ?? null,
    threadId: m.thread_id ?? null,
  };
}
export async function handleBbsList(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const to = u.searchParams.get("to");
  if (!to) return json({ error: "to (callsign) required" }, { status: 400 });
  const denied = await requireMailbox(req, env, to);
  if (denied) return denied;
  const cs = to.toUpperCase();
  const msgs = (
    await env.DB.prepare(`SELECT * FROM bbs_messages WHERE type='P' AND to_call=? ORDER BY posted_at DESC LIMIT 200`)
      .bind(cs)
      .all()
  ).results;
  return json({ messages: msgs.map(row) });
}
export async function handleBbsBulletins(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const cat = u.searchParams.get("category");
  const n = nowS();
  // The reserved federation category (ACSFED) is machine carrier traffic, not human mail — it is
  // hidden from the default listing but still reachable by asking for the category explicitly.
  let sql = "SELECT * FROM bbs_messages WHERE type='B' AND (expires_at IS NULL OR expires_at > ?)";
  const binds: unknown[] = [n];
  if (cat) {
    sql += " AND to_call=?";
    binds.push(cat.toUpperCase());
  } else {
    sql += ` AND to_call != '${FED_BBS_CATEGORY}'`;
  }
  sql += " ORDER BY posted_at DESC LIMIT 200";
  const rows = (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all()
  ).results;
  return json({ bulletins: rows.map(row) });
}
export async function handleBbsRead(req: Request, env: Env, id: number): Promise<Response> {
  const msg = await env.DB.prepare("SELECT to_call FROM bbs_messages WHERE id=?").bind(id).first<{ to_call: string }>();
  if (!msg) return json({ error: "no such message" }, { status: 404 });
  // only the addressee marks its mail read
  const denied = await requireMailbox(req, env, msg.to_call);
  if (denied) return denied;
  await env.DB.prepare("UPDATE bbs_messages SET read_at=? WHERE id=? AND read_at IS NULL").bind(nowS(), id).run();
  return json({ ok: true });
}

// -------------------------------------- connected-mode BBS session
const ingestOk = ingestOrServiceBoxOk;

/**
 * GET /api/bbs/session?call=CALL — the per-caller mail snapshot an inbound connected-mode BBS session
 * serves synchronously (personal to/from the caller + current bulletins, with bodies). This is also the
 * access boundary: the connected user can only read what's in their own snapshot. Ingest-secret gated.
 */
export async function handleBbsSession(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return new Response("unauthorized", { status: 401 });
  const call = (new URL(req.url).searchParams.get("call") ?? "").toUpperCase();
  if (!call) return json({ error: "call required" }, { status: 400 });
  const rows = (
    await env.DB.prepare(
      `SELECT id, type, from_call, to_call, subject, body, posted_at, reply_to, read_at
       FROM bbs_messages
      WHERE (expires_at IS NULL OR expires_at > ?) AND (type='B' OR to_call=? OR from_call=?)
      ORDER BY posted_at DESC LIMIT 300`,
    )
      .bind(nowS(), call, call)
      .all<any>()
  ).results;
  const messages = rows.map((m) => ({
    id: m.id,
    type: m.type,
    from: m.from_call,
    to: m.to_call,
    subject: m.subject,
    postedAt: m.posted_at,
    body: m.body,
    replyTo: m.reply_to ?? null,
    readAt: m.read_at ?? null,
  }));
  return json({ call, messages });
}

/** POST /api/bbs/kill {id, call} — remove a message the caller authored/received. Ingest-secret gated. */
export async function handleBbsKill(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: number; call?: string };
  if (!b.id || !b.call) return json({ error: "id + call required" }, { status: 400 });
  const cs = b.call.toUpperCase();
  const res = await env.DB.prepare("DELETE FROM bbs_messages WHERE id=? AND (from_call=? OR to_call=?)")
    .bind(b.id, cs, cs)
    .run();
  return json({ ok: true, killed: !!res.meta.changes });
}

/** GET /api/bbs/sent?from= — personal mail YOU sent, with its F6FBB state: read here, or forwarded to partners. */
export async function handleBbsSent(req: Request, env: Env): Promise<Response> {
  const from = new URL(req.url).searchParams.get("from");
  if (!from) return json({ error: "from (callsign) required" }, { status: 400 });
  const denied = await requireMailbox(req, env, from);
  if (denied) return denied;
  const msgs = (
    await env.DB.prepare(
      `SELECT m.*, (SELECT group_concat(f.partner) FROM bbs_forward_log f WHERE f.bid = m.bid) AS forwardedTo
       FROM bbs_messages m
      WHERE m.type='P' AND m.from_call=? AND m.origin='local' ORDER BY m.posted_at DESC LIMIT 200`,
    )
      .bind(from.toUpperCase())
      .all()
  ).results;
  return json({
    messages: msgs.map((m: any) => ({
      ...row(m),
      forwardedTo: m.forwardedTo ? String(m.forwardedTo).split(",") : [],
    })),
  });
}

// ---------------------------------------------------------------- bulletin federation
interface BulletinRow {
  id: number;
  bid: string | null;
  from_call: string;
  to_call: string;
  subject: string | null;
  body: string;
  posted_at: number;
  expires_at: number | null;
}

/**
 * Serve this instance's LOCAL bulletins as a signed federation feed (mirrors of peers' bulletins
 * carry origin != 'local' and are filtered out, so a bulletin never loops back to its source). BID is
 * the stable cross-instance id; the consumer dedups on it.
 */
export const BULLETIN_FEED: FeedServeDef<BulletinRow> = {
  type: "bulletin",
  composite: true,
  selectRows: async (env, since, limit, sinceId = -1) =>
    (
      await env.DB.prepare(
        `SELECT id, bid, from_call, to_call, subject, body, posted_at, expires_at FROM bbs_messages
       WHERE type='B' AND origin='local' AND (expires_at IS NULL OR expires_at > ?)
         AND (posted_at > ? OR (posted_at = ? AND id > ?))
       ORDER BY posted_at, id LIMIT ?`,
      )
        .bind(nowS(), since, since, sinceId, limit)
        .all<BulletinRow>()
    ).results,
  // the gid lives in the instance's namespace like every record; the FBB BID (the cross-mesh dedup
  // key) rides in the body
  recordOf: (r, instance) => ({
    id: `${instance}:bulletin:${r.id}`,
    cursor: r.posted_at,
    data: {
      bid: r.bid ?? `${r.id}_${instance}`,
      fromCall: r.from_call,
      toCall: r.to_call,
      subject: r.subject,
      body: r.body,
      postedAt: r.posted_at,
      expiresAt: r.expires_at,
    },
  }),
};

/** Mirror a peer's bulletin into the local base (BID-deduped, never re-served — origin = the peer). */
export async function upsertRemoteBulletin(
  env: Env,
  rec: { id: string; data: Record<string, unknown> },
  origin: string,
): Promise<void> {
  const d = rec.data as {
    bid?: string;
    fromCall?: string;
    toCall?: string;
    subject?: string | null;
    body?: string;
    postedAt?: number;
    expiresAt?: number | null;
  };
  // A mirror is stored under the record's gid, never under the FBB BID it carries: a peer cannot prove a BID
  // is its own, and a claimed BID would squat the bulletin it names (another BBS's, or one of ours). The BID
  // still dedups against a copy that arrived by FBB forwarding first.
  const bid = rec.id;
  if (!d.fromCall || !d.toCall || !d.body || !bid) return;
  if (
    typeof d.bid === "string" &&
    (await env.DB.prepare("SELECT 1 AS x FROM bbs_messages WHERE bid = ?").bind(d.bid).first())
  )
    return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bbs_messages (bid, type, from_call, to_call, subject, body, posted_at, expires_at, origin)
     VALUES (?, 'B', ?,?,?,?,?,?,?)`,
  )
    .bind(
      bid,
      String(d.fromCall).toUpperCase(),
      String(d.toCall).toUpperCase(),
      d.subject ?? null,
      String(d.body),
      d.postedAt ?? nowS(),
      d.expiresAt ?? nowS() + BULLETIN_LIFETIME_SEC,
      origin,
    )
    .run();
}

// ---------------------------------------------------------------- store-and-forward delivery
