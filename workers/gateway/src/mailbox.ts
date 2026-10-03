// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * mailbox.ts — the Mailbox: a short message held for a callsign until its station is heard on the air, then
 * sent to it as an APRS message from the service call and confirmed by the station's ack. It is separate from
 * the BBS, which moves its mail the F6FBB way only: a Mailbox message is never a BBS message, never forwarded
 * to a BBS and never federated.
 *
 * A message is left in the app or by a `MAIL <call> <text>` radio command, always under a control-verified
 * callsign of the sender's, because the instance puts its text on the air. Mail to a base call goes to
 * whichever SSID of it is heard first; mail to a call with an SSID waits for that station. It expires after
 * {@link MAILBOX_TTL_SEC}.
 */
import { baseCall, encodeAprsMessage } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { nowS } from "./util/time.js";
import { sessionIdentity } from "./auth.js";
import { isCallsignVerified } from "./callsign.js";
import { serviceCall } from "./servicecall.js";
import { freshBoxCaps, enqueueSystemBoxCommand } from "./box.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";

/** How long a message waits for its station. */
const MAILBOX_TTL_SEC = 7 * 86400;
/** Deliveries without an ack before a message counts as undelivered. */
const MAX_ATTEMPTS = 5;
/** Seconds between two deliveries of one message. */
const RETRY_SEC = 60;
/** Messages one account may leave an hour. */
const PER_HOUR = 20;
/** Messages that may wait for one station at a time. */
const HELD_PER_ADDRESSEE = 10;
/** Delivered and expired messages stay listed this long, then are deleted. */
const KEEP_SEC = 30 * 86400;
/** The APRS message text limit. */
const APRS_TEXT_MAX = 67;

/** A callsign a Mailbox message can be addressed to: a base with a digit, and an optional SSID. */
const CALL = /^(?=[A-Z0-9]*\d)[A-Z0-9]{1,6}(-\d{1,2})?$/;

/** The text the station receives. */
const mailText = (from: string, body: string) => `de ${from}: ${body}`;

/** The most a body may hold so that {@link mailText} fits one APRS message. */
const bodyMax = (from: string) => APRS_TEXT_MAX - mailText(from, "").length;

/** Printable ASCII only, without the APRS-reserved `|`, `~` and `{`. */
const clean = (s: string) =>
  s
    .replace(/[‐-―]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[|~{]/g, "")
    .trim();

/** A message's number on the air: its id in base 36, at most five characters. */
const msgNoOf = (id: number) => (id % 36 ** 5).toString(36).toUpperCase();

interface LeaveMail {
  from: string;
  accountId: string;
  to: string;
  body: string;
  via: "app" | "radio";
}

/** Hold a message, or say why not. The caller has checked that `from` is the sender's verified call. */
export async function leaveMail(env: Env, m: LeaveMail): Promise<{ id: number } | { error: string; status: number }> {
  const from = m.from.trim().toUpperCase();
  const to = m.to.trim().toUpperCase();
  const body = clean(m.body);
  if (!CALL.test(to)) return { error: `${to || "the addressee"} is not a callsign`, status: 400 };
  if (to === serviceCall(env)) return { error: "that is this instance's own call", status: 400 };
  if (!body) return { error: "the message is empty", status: 400 };
  if (body.length > bodyMax(from))
    return { error: `the message is longer than ${bodyMax(from)} characters`, status: 400 };
  if (await rateLimitedDurable(env, `mailbox:${m.accountId}`, Date.now(), PER_HOUR, 3600_000))
    return { error: `at most ${PER_HOUR} messages an hour`, status: 429 };
  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mailbox_messages WHERE to_call IN (?, ?) AND status IN ('held','sent')",
  )
    .bind(to, baseCall(to))
    .first<{ n: number }>();
  if ((waiting?.n ?? 0) >= HELD_PER_ADDRESSEE)
    return { error: `${HELD_PER_ADDRESSEE} messages already wait for ${to}`, status: 429 };
  const now = nowS();
  const r = await env.DB.prepare(
    `INSERT INTO mailbox_messages (from_call, from_account, to_call, body, via, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(from, m.accountId, to, body, m.via, now, now + MAILBOX_TTL_SEC)
    .run();
  return { id: Number(r.meta?.last_row_id) };
}

/** POST /api/mailbox {from, to, text} — leave a message under one of the signed-in account's verified calls. */
export async function handleMailboxPost(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown; text?: unknown };
  const from = typeof b.from === "string" ? b.from.trim().toUpperCase() : "";
  if (!CALL.test(from)) return json({ error: "from must be a callsign" }, { status: 400 });
  const own = await env.DB.prepare("SELECT 1 AS x FROM account_callsigns WHERE account_id = ? AND callsign = ?")
    .bind(me.accountId, baseCall(from))
    .first();
  if (!own) return json({ error: `${baseCall(from)} is not a callsign on your account` }, { status: 403 });
  if (!(await isCallsignVerified(env, from)))
    return json({ error: `verify ${baseCall(from)} first: the message goes out on the air` }, { status: 403 });
  const r = await leaveMail(env, {
    from,
    accountId: me.accountId,
    to: typeof b.to === "string" ? b.to : "",
    body: typeof b.text === "string" ? b.text : "",
    via: "app",
  });
  return "error" in r ? json({ error: r.error }, { status: r.status }) : json({ ok: true, id: r.id }, { status: 201 });
}

interface MailRow {
  id: number;
  from_call: string;
  to_call: string;
  body: string;
  via: string;
  status: string;
  delivered_to: string | null;
  created_at: number;
  expires_at: number;
  delivered_at: number | null;
  attempts: number;
}
const view = (r: MailRow) => ({
  id: r.id,
  from: r.from_call,
  to: r.to_call,
  text: r.body,
  via: r.via,
  status: r.status,
  deliveredTo: r.delivered_to,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  deliveredAt: r.delivered_at,
  attempts: r.attempts,
});

/** GET /api/mailbox — the messages the account left, and those waiting for any of its calls. */
export async function handleMailboxList(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const sent = (
    await env.DB.prepare("SELECT * FROM mailbox_messages WHERE from_account = ? ORDER BY created_at DESC LIMIT 100")
      .bind(me.accountId)
      .all<MailRow>()
  ).results;
  const bases = (
    await env.DB.prepare("SELECT callsign FROM account_callsigns WHERE account_id = ?")
      .bind(me.accountId)
      .all<{ callsign: string }>()
  ).results.map((r) => r.callsign);
  const received = bases.length
    ? (
        await env.DB.prepare(
          `SELECT * FROM mailbox_messages WHERE ${bases.map(() => "(to_call = ? OR to_call LIKE ?)").join(" OR ")}
           ORDER BY created_at DESC LIMIT 100`,
        )
          .bind(...bases.flatMap((c) => [c, `${c}-%`]))
          .all<MailRow>()
      ).results
    : [];
  return json({ sent: sent.map(view), received: received.map(view) });
}

/** DELETE /api/mailbox/:id — the sender withdraws a message still waiting. */
export async function handleMailboxWithdraw(req: Request, env: Env, id: number): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const r = await env.DB.prepare(
    "DELETE FROM mailbox_messages WHERE id = ? AND from_account = ? AND status IN ('held','sent')",
  )
    .bind(id, me.accountId)
    .run();
  return (r.meta?.changes ?? 0) === 1
    ? json({ ok: true })
    : json({ error: "no such message waiting" }, { status: 404 });
}

/** A station heard in an ingest batch, and how: the route a message to it takes. */
export interface Heard {
  src: string;
  port: string;
  /** The ingest box that heard it on its own radio, when the batch came from that box. */
  box?: string;
}

/** Ports on which the box itself received the frame over a radio it can also transmit on. */
const RF_PORTS = new Set(["kiss-tnc"]);

/**
 * Send the messages waiting for the stations of a batch. Over APRS a message goes back the way its station
 * was heard: through the box that heard it on its own radio, else through the APRS-IS outbox. A station
 * heard only on MeshCom waits for a MeshCom delivery path. One read covers the whole batch.
 */
export async function deliverMailbox(env: Env, heard: Heard[]): Promise<void> {
  const now = nowS();
  const waiting = (
    await env.DB.prepare(
      `SELECT * FROM mailbox_messages WHERE status IN ('held','sent') AND expires_at > ?
         AND attempts < ? AND (last_attempt IS NULL OR last_attempt <= ?) LIMIT 500`,
    )
      .bind(now, MAX_ATTEMPTS, now - RETRY_SEC)
      .all<MailRow>()
  ).results;
  if (!waiting.length) return;
  const byCall = new Map<string, Heard>();
  for (const h of heard) if (h.port !== "meshcom") byCall.set(h.src.toUpperCase(), h);
  const service = serviceCall(env);
  for (const m of waiting) {
    // mail to a base call reaches the first SSID heard; mail to an SSID only that station
    const h =
      byCall.get(m.to_call) ??
      (m.to_call.includes("-") ? undefined : [...byCall.values()].find((x) => baseCall(x.src) === m.to_call));
    if (!h) continue;
    const to = h.src.toUpperCase();
    const text = mailText(m.from_call, m.body);
    const msgNo = msgNoOf(m.id);
    const caps = h.box ? await freshBoxCaps(env, h.box) : null;
    if (caps?.tx && caps.rf && RF_PORTS.has(h.port))
      await enqueueSystemBoxCommand(env, h.box!, "aprs_msg", { from: service, to, text, msgNo });
    else
      await env.DB.prepare(
        "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?, ?, 'APZACG', 'message', ?)",
      )
        .bind(now, service, encodeAprsMessage(to, text, msgNo))
        .run();
    const tries = m.attempts + 1;
    await env.DB.prepare(
      `UPDATE mailbox_messages SET status = ?, delivered_to = ?, msg_no = ?, attempts = ?, last_attempt = ?
        WHERE id = ? AND status IN ('held','sent')`,
    )
      .bind(tries >= MAX_ATTEMPTS ? "undelivered" : "sent", to, msgNo, tries, now, m.id)
      .run();
  }
}

/** An ack addressed to the service call: the station received the message with that number. */
export async function mailboxOnAck(env: Env, from: string, msgNo: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE mailbox_messages SET status = 'delivered', delivered_at = ?
      WHERE delivered_to = ? AND msg_no = ? AND status IN ('sent','undelivered')`,
  )
    .bind(nowS(), from.toUpperCase(), msgNo.toUpperCase())
    .run();
}

/** Daily: expire what waited too long, and delete what has been settled for {@link KEEP_SEC}. */
export async function expireMailbox(env: Env): Promise<void> {
  const now = nowS();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE mailbox_messages SET status = 'expired' WHERE status IN ('held','sent') AND expires_at <= ?",
    ).bind(now),
    env.DB.prepare("DELETE FROM mailbox_messages WHERE expires_at <= ? AND status != 'held'").bind(now - KEEP_SEC),
  ]);
}
