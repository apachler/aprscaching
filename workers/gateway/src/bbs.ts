// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * bbs.ts — store-and-forward message BBS (Stage 1, connectionless). A message base of personal mail
 * + bulletins. Personal mail is *held* until the addressee is next *heard* (deliverHeld, called from
 * ingest), then *forwarded* as a standard APRS message via the outbox, with line-number ack tracking
 * and bounded retry. Bulletins are retrievable. BID + P/B typing are MBL/FBB-compatible so a future
 * connected-mode gateway can bridge to real F6FBB/BPQ32 nodes.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import type { FeedServeDef } from "./federation.js";

const now = () => Math.floor(Date.now() / 1000);
const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL = 60;     // seconds between (re)delivery attempts
const APRS_BODY_MAX = 67;      // APRS message text limit
const BULLETIN_TO = /^(ALL|SYSOP|BLN|NWS|SKY)/i;

const relayCall = (env: Env) => (env.BBS_CALL ?? "APRSCG").toUpperCase();
const instanceOf = (env: Env, req: Request) => env.INSTANCE ?? new URL(req.url).host;

// ---------------------------------------------------------------- post
export async function handleBbsPost(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { fromCall?: string; toCall?: string; type?: string; subject?: string; body?: string; lifetimeSec?: number; replyTo?: number };
  if (!b.fromCall || !b.toCall || !b.body) return json({ error: "fromCall, toCall, body required" }, { status: 400 });
  const from = b.fromCall.toUpperCase(), to = b.toCall.toUpperCase();
  const type = (b.type === "B" || b.type === "P" || b.type === "T") ? b.type : (BULLETIN_TO.test(to) ? "B" : "P");
  const posted = now();
  const expires = b.lifetimeSec ? posted + b.lifetimeSec : (type === "B" ? posted + 30 * 86400 : null);

  // SR (reply): inherit the parent's conversation root so replies chain into a thread
  let replyTo: number | null = null, threadRoot: number | null = null;
  if (b.replyTo) {
    const parent = await env.DB.prepare("SELECT id, thread_id FROM bbs_messages WHERE id=?").bind(b.replyTo).first<{ id: number; thread_id: number | null }>();
    if (parent) { replyTo = parent.id; threadRoot = parent.thread_id ?? parent.id; }
  }

  const res = await env.DB.prepare(
    "INSERT INTO bbs_messages (type, from_call, to_call, subject, body, posted_at, expires_at, origin, reply_to) VALUES (?,?,?,?,?,?,?, 'local', ?)",
  ).bind(type, from, to, b.subject ?? null, b.body, posted, expires, replyTo).run();
  const id = Number(res.meta.last_row_id);
  const bid = `${id}_${instanceOf(env, req)}`;
  // a root message threads to itself; a reply keeps the parent's root
  await env.DB.prepare("UPDATE bbs_messages SET bid=?, thread_id=? WHERE id=?").bind(bid, threadRoot ?? id, id).run();
  if (type === "P") await env.DB.prepare("INSERT INTO bbs_delivery (msg_id, to_call, status) VALUES (?,?, 'held')").bind(id, to).run();

  return json({ ok: true, id, bid, type, threadId: threadRoot ?? id, replyTo }, { status: 201 });
}

/** GET /api/bbs/thread/:id — a conversation (root + all replies), oldest first. */
export async function handleBbsThread(req: Request, env: Env, id: number): Promise<Response> {
  const root = await env.DB.prepare("SELECT thread_id FROM bbs_messages WHERE id=?").bind(id).first<{ thread_id: number | null }>();
  const threadId = root?.thread_id ?? id;
  const msgs = (await env.DB.prepare(
    "SELECT * FROM bbs_messages WHERE thread_id=? OR id=? ORDER BY posted_at ASC LIMIT 200",
  ).bind(threadId, threadId).all()).results;
  return json({ threadId, messages: msgs.map(row) });
}

// ---------------------------------------------------------------- read views
function row(m: any) {
  return { id: m.id, bid: m.bid, type: m.type, fromCall: m.from_call, toCall: m.to_call, subject: m.subject, body: m.body, postedAt: m.posted_at, origin: m.origin, readAt: m.read_at, replyTo: m.reply_to ?? null, threadId: m.thread_id ?? null };
}
export async function handleBbsList(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const to = u.searchParams.get("to");
  if (!to) return json({ error: "to (callsign) required" }, { status: 400 });
  const cs = to.toUpperCase();
  const msgs = (await env.DB.prepare(
    `SELECT m.*, d.status AS delivery, d.line_no AS lineNo, d.attempts, d.acked_at AS ackedAt
       FROM bbs_messages m LEFT JOIN bbs_delivery d ON d.msg_id=m.id
      WHERE m.type='P' AND m.to_call=? ORDER BY m.posted_at DESC LIMIT 200`,
  ).bind(cs).all()).results;
  return json({ messages: msgs.map((m: any) => ({ ...row(m), delivery: m.delivery, lineNo: m.lineNo, attempts: m.attempts, ackedAt: m.ackedAt })) });
}
export async function handleBbsBulletins(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const cat = u.searchParams.get("category");
  const n = now();
  let sql = "SELECT * FROM bbs_messages WHERE type='B' AND (expires_at IS NULL OR expires_at > ?)";
  const binds: unknown[] = [n];
  if (cat) { sql += " AND to_call=?"; binds.push(cat.toUpperCase()); }
  sql += " ORDER BY posted_at DESC LIMIT 200";
  const rows = (await env.DB.prepare(sql).bind(...binds).all()).results;
  return json({ bulletins: rows.map(row) });
}
export async function handleBbsRead(req: Request, env: Env, id: number): Promise<Response> {
  await env.DB.prepare("UPDATE bbs_messages SET read_at=? WHERE id=? AND read_at IS NULL").bind(now(), id).run();
  return json({ ok: true });
}

// -------------------------------------- connected-mode BBS session
const ingestOk = (req: Request, env: Env) => req.headers.get("x-ingest-secret") === env.INGEST_SECRET;

/**
 * GET /api/bbs/session?call=CALL — the per-caller mail snapshot an inbound connected-mode BBS session
 * serves synchronously (personal to/from the caller + current bulletins, with bodies). This is also the
 * access boundary: the connected user can only read what's in their own snapshot. Ingest-secret gated.
 */
export async function handleBbsSession(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return new Response("unauthorized", { status: 401 });
  const call = (new URL(req.url).searchParams.get("call") ?? "").toUpperCase();
  if (!call) return json({ error: "call required" }, { status: 400 });
  const rows = (await env.DB.prepare(
    `SELECT id, type, from_call, to_call, subject, body, posted_at, reply_to, read_at
       FROM bbs_messages
      WHERE (expires_at IS NULL OR expires_at > ?) AND (type='B' OR to_call=? OR from_call=?)
      ORDER BY posted_at DESC LIMIT 300`,
  ).bind(now(), call, call).all<any>()).results;
  const messages = rows.map((m) => ({
    id: m.id, type: m.type, from: m.from_call, to: m.to_call, subject: m.subject,
    postedAt: m.posted_at, body: m.body, replyTo: m.reply_to ?? null, readAt: m.read_at ?? null,
  }));
  return json({ call, messages });
}

/** POST /api/bbs/kill {id, call} — remove a message the caller authored/received. Ingest-secret gated. */
export async function handleBbsKill(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: number; call?: string };
  if (!b.id || !b.call) return json({ error: "id + call required" }, { status: 400 });
  const cs = b.call.toUpperCase();
  const res = await env.DB.prepare("DELETE FROM bbs_messages WHERE id=? AND (from_call=? OR to_call=?)").bind(b.id, cs, cs).run();
  await env.DB.prepare("DELETE FROM bbs_delivery WHERE msg_id=?").bind(b.id).run();
  return json({ ok: true, killed: !!res.meta.changes });
}

/** GET /api/bbs/sent?from= — personal mail YOU sent, with its store-and-forward delivery state. */
export async function handleBbsSent(req: Request, env: Env): Promise<Response> {
  const from = new URL(req.url).searchParams.get("from");
  if (!from) return json({ error: "from (callsign) required" }, { status: 400 });
  const msgs = (await env.DB.prepare(
    `SELECT m.*, d.status AS delivery, d.line_no AS lineNo, d.attempts, d.acked_at AS ackedAt
       FROM bbs_messages m LEFT JOIN bbs_delivery d ON d.msg_id=m.id
      WHERE m.type='P' AND m.from_call=? AND m.origin='local' ORDER BY m.posted_at DESC LIMIT 200`,
  ).bind(from.toUpperCase()).all()).results;
  return json({ messages: msgs.map((m: any) => ({ ...row(m), delivery: m.delivery, lineNo: m.lineNo, attempts: m.attempts, ackedAt: m.ackedAt })) });
}

// ---------------------------------------------------------------- bulletin federation (BBS #1)
interface BulletinRow { id: number; bid: string | null; from_call: string; to_call: string; subject: string | null; body: string; posted_at: number; expires_at: number | null }

/**
 * Serve this instance's LOCAL bulletins as a signed federation feed (mirrors of peers' bulletins
 * carry origin != 'local' and are filtered out, so a bulletin never loops back to its source). BID is
 * the stable cross-instance id; the consumer dedups on it.
 */
export const BULLETIN_FEED: FeedServeDef<BulletinRow> = {
  type: "bulletin",
  selectRows: async (env, since, limit) => (await env.DB.prepare(
    `SELECT id, bid, from_call, to_call, subject, body, posted_at, expires_at FROM bbs_messages
       WHERE type='B' AND origin='local' AND (expires_at IS NULL OR expires_at > ?) AND posted_at >= ?
       ORDER BY posted_at, id LIMIT ?`,
  ).bind(now(), since, limit).all<BulletinRow>()).results,
  recordOf: (r, instance) => ({
    id: r.bid ?? `${r.id}_${instance}`,
    cursor: r.posted_at,
    data: { fromCall: r.from_call, toCall: r.to_call, subject: r.subject, body: r.body, postedAt: r.posted_at, expiresAt: r.expires_at },
  }),
};

/** Mirror a peer's bulletin into the local base (BID-deduped, never re-served — origin = the peer). */
export async function upsertRemoteBulletin(env: Env, rec: { id: string; data: Record<string, unknown> }, origin: string): Promise<void> {
  const d = rec.data as { fromCall?: string; toCall?: string; subject?: string | null; body?: string; postedAt?: number; expiresAt?: number | null };
  if (!d.fromCall || !d.toCall || !d.body || !rec.id) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bbs_messages (bid, type, from_call, to_call, subject, body, posted_at, expires_at, origin)
     VALUES (?, 'B', ?,?,?,?,?,?,?)`,
  ).bind(rec.id, String(d.fromCall).toUpperCase(), String(d.toCall).toUpperCase(), d.subject ?? null, String(d.body), d.postedAt ?? now(), d.expiresAt ?? null, origin).run();
}

// ---------------------------------------------------------------- store-and-forward delivery
/** Called when `callsign` is heard: (re)deliver any held/unacked personal mail to it over APRS. */
export async function deliverHeld(env: Env, callsign: string): Promise<number> {
  const cs = callsign.toUpperCase();
  const n = now();
  const due = (await env.DB.prepare(
    `SELECT d.msg_id AS msgId, d.attempts, m.from_call AS fromCall, m.body
       FROM bbs_delivery d JOIN bbs_messages m ON m.id=d.msg_id
      WHERE d.to_call=? AND d.acked_at IS NULL AND d.status IN ('held','sent')
        AND d.attempts < ? AND (d.last_attempt IS NULL OR d.last_attempt <= ?)
      LIMIT 10`,
  ).bind(cs, MAX_ATTEMPTS, n - RETRY_INTERVAL).all<{ msgId: number; attempts: number; fromCall: string; body: string }>()).results;
  if (!due.length) return 0;

  const stmts = [];
  for (const d of due) {
    const text = `de ${d.fromCall}: ${d.body}`.slice(0, APRS_BODY_MAX);
    const payload = `:${cs.padEnd(9)}:${text}{${d.msgId}`;     // line number = msg id (unique per recipient)
    stmts.push(env.DB.prepare("INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?,?, 'APZACG', 'message', ?)").bind(n, relayCall(env), payload));
    stmts.push(env.DB.prepare("UPDATE bbs_delivery SET status='sent', line_no=?, attempts=attempts+1, last_attempt=? WHERE msg_id=? AND to_call=?").bind(d.msgId, n, d.msgId, cs));
  }
  // expire anything that just hit the attempt ceiling
  stmts.push(env.DB.prepare("UPDATE bbs_delivery SET status='expired' WHERE to_call=? AND acked_at IS NULL AND attempts >= ?").bind(cs, MAX_ATTEMPTS));
  await env.DB.batch(stmts);
  return due.length;
}

/** Called when an APRS ack is received: mark the matching delivery acked. */
export async function bbsOnAck(env: Env, fromCall: string, lineNo: string | number): Promise<void> {
  const n = Number(lineNo);
  if (!Number.isFinite(n)) return;
  await env.DB.prepare("UPDATE bbs_delivery SET status='acked', acked_at=? WHERE to_call=? AND line_no=? AND acked_at IS NULL")
    .bind(now(), fromCall.toUpperCase(), n).run();
}
