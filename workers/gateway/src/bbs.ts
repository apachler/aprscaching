/**
 * bbs.ts — store-and-forward message BBS (Stage 1, connectionless). A message base of personal mail
 * + bulletins. Personal mail is *held* until the addressee is next *heard* (deliverHeld, called from
 * ingest), then *forwarded* as a standard APRS message via the outbox, with line-number ack tracking
 * and bounded retry. Bulletins are retrievable. BID + P/B typing are MBL/FBB-compatible so a future
 * connected-mode gateway can bridge to real F6FBB/BPQ32 nodes.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";

const now = () => Math.floor(Date.now() / 1000);
const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL = 60;     // seconds between (re)delivery attempts
const APRS_BODY_MAX = 67;      // APRS message text limit
const BULLETIN_TO = /^(ALL|SYSOP|BLN|NWS|SKY)/i;

const relayCall = (env: Env) => (env.BBS_CALL ?? "APRSCG").toUpperCase();
const instanceOf = (env: Env, req: Request) => env.INSTANCE ?? new URL(req.url).host;

// ---------------------------------------------------------------- post
export async function handleBbsPost(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { fromCall?: string; toCall?: string; type?: string; subject?: string; body?: string; lifetimeSec?: number };
  if (!b.fromCall || !b.toCall || !b.body) return json({ error: "fromCall, toCall, body required" }, { status: 400 });
  const from = b.fromCall.toUpperCase(), to = b.toCall.toUpperCase();
  const type = b.type === "B" || b.type === "P" ? b.type : (BULLETIN_TO.test(to) ? "B" : "P");
  const posted = now();
  const expires = b.lifetimeSec ? posted + b.lifetimeSec : (type === "B" ? posted + 30 * 86400 : null);

  const res = await env.DB.prepare(
    "INSERT INTO bbs_messages (type, from_call, to_call, subject, body, posted_at, expires_at, origin) VALUES (?,?,?,?,?,?,?, 'local')",
  ).bind(type, from, to, b.subject ?? null, b.body, posted, expires).run();
  const id = res.meta.last_row_id;
  const bid = `${id}_${instanceOf(env, req)}`;
  await env.DB.prepare("UPDATE bbs_messages SET bid=? WHERE id=?").bind(bid, id).run();
  if (type === "P") await env.DB.prepare("INSERT INTO bbs_delivery (msg_id, to_call, status) VALUES (?,?, 'held')").bind(id, to).run();

  return json({ ok: true, id, bid, type }, { status: 201 });
}

// ---------------------------------------------------------------- read views
function row(m: any) {
  return { id: m.id, bid: m.bid, type: m.type, fromCall: m.from_call, toCall: m.to_call, subject: m.subject, body: m.body, postedAt: m.posted_at, origin: m.origin, readAt: m.read_at };
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
