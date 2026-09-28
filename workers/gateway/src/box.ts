// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * box.ts — remote control of an operator's own ingest box. The web app enqueues
 * commands; the box pulls them over its existing outbound connection (no inbound ports), executes,
 * and acks. The ECHOCAT pattern with the gateway as the rendezvous.
 *
 *   POST /api/box/:id/command         enqueue (session or box secret; TX kinds are control-verified)
 *   GET  /api/box/:id/commands        the box leases queued commands (x-ingest-secret) → marks them sent;
 *                                     `?tx=1&rf=1&meshcom=CALL,…` reports what it can transmit (box_status)
 *   POST /api/box/:id/commands/ack    the box reports done/failed (x-ingest-secret)
 *   GET  /api/box/:id/log             operator view of recent commands + status (session or secret)
 *
 * Gating (non-negotiable): every TX-capable command requires a callsign gated on control-verification;
 * RX-only boxes simply never receive TX kinds. This is operator→own-box control, distinct
 * from the federation/APRS service identity.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId, secretOk } from "./auth.js";

const TX_KINDS = new Set(["beacon", "message", "wx_beacon", "igate", "digi", "tx"]);
const ALL_KINDS = new Set([...TX_KINDS, "status"]);
const now = () => Math.floor(Date.now() / 1000);
const boxAuth = (req: Request, env: Env) => secretOk(req.headers.get("x-ingest-secret"), env.INGEST_SECRET);
const base = (c: string) => c.toUpperCase().split("-")[0] ?? "";

async function isVerified(env: Env, call: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM callsign_verifications WHERE callsign = ? AND status = 'verified'")
    .bind(call.toUpperCase())
    .first();
  return !!r;
}

/**
 * Authorize a session to control `boxId`. TOFU — the first account to control a box claims
 * ownership; thereafter only that account may enqueue to it. Returns the owning accountId, or null if
 * this session is not allowed to control the box.
 */
async function ownBox(env: Env, boxId: string, accountId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT account_id FROM boxes WHERE box_id = ?")
    .bind(boxId)
    .first<{ account_id: string }>();
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO boxes (box_id, account_id, created_at) VALUES (?,?,?)")
      .bind(boxId, accountId, now())
      .run();
    return true;
  }
  return row.account_id === accountId;
}
/** Does `accountId` hold the given base callsign (so it may transmit as it)? */
async function accountHoldsCall(env: Env, accountId: string, call: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM account_callsigns WHERE account_id = ? AND callsign = ?")
    .bind(accountId, base(call))
    .first();
  return !!r;
}

/** POST /api/box/:id/command — the operator enqueues a command for their box. */
export async function handleBoxEnqueue(req: Request, env: Env, boxId: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    payload?: unknown;
    callsign?: string;
    sig?: string;
  };
  const kind = String(body.kind ?? "").toLowerCase();
  if (!ALL_KINDS.has(kind))
    return json({ error: `unknown command kind; one of ${[...ALL_KINDS].join(", ")}` }, { status: 400 });
  // authorize: a signed-in operator session that OWNS this box, or the box secret (trusted
  // backend / the operator's own box). Read commands need no callsign; TX commands require a verified one.
  const me = await sessionAccountId(req, env);
  const trusted = boxAuth(req, env);
  if (!me && !trusted) return json({ error: "sign in (or provide the box secret) to control a box" }, { status: 401 });
  if (me && !trusted && !(await ownBox(env, boxId, me.accountId)))
    return json({ error: "this box belongs to another operator" }, { status: 403 });
  // A session may only transmit as a callsign its own account holds; the trusted backend may name any.
  const callsign = (body.callsign ?? me?.callsign ?? "").toUpperCase();
  if (TX_KINDS.has(kind)) {
    if (!callsign) return json({ error: "a licensed callsign is required to transmit" }, { status: 400 });
    if (me && !trusted && !(await accountHoldsCall(env, me.accountId, callsign)))
      return json({ error: `${callsign} is not held by your account` }, { status: 403 });
    if (!(await isVerified(env, callsign)))
      return json({ error: `verify ${callsign} to transmit — control-verification required` }, { status: 403 });
  }

  const ins = await env.DB.prepare(
    "INSERT INTO box_commands (box_id, callsign, kind, payload, sig, status, created_at) VALUES (?,?,?,?,?, 'queued', ?)",
  )
    .bind(boxId, callsign, kind, body.payload != null ? JSON.stringify(body.payload) : null, body.sig ?? null, now())
    .run();
  return json(
    { id: Number(ins.meta.last_row_id), boxId, kind, callsign, status: "queued", tx: TX_KINDS.has(kind) },
    { status: 201 },
  );
}

/** What a box reported it can transmit on its last poll. */
export interface BoxCaps {
  tx: boolean;
  rf: boolean;
  meshcom: string[];
}

/** Parse the capability report a box sends with its poll (`?tx=1&rf=1&meshcom=CALL,…`). */
export function parseBoxCaps(url: URL): BoxCaps {
  const meshcom = (url.searchParams.get("meshcom") ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$/.test(c))
    .slice(0, 8);
  return { tx: url.searchParams.get("tx") === "1", rf: url.searchParams.get("rf") === "1", meshcom };
}

/** A box that polled within this many seconds is considered reachable for a reply. */
export const BOX_FRESH_SEC = 120;

/** The box's last capability report, or null when it has not polled recently. */
export async function freshBoxCaps(env: Env, boxId: string): Promise<BoxCaps | null> {
  const r = await env.DB.prepare("SELECT caps, last_seen FROM box_status WHERE box_id = ?")
    .bind(boxId)
    .first<{ caps: string; last_seen: number }>();
  if (!r || now() - r.last_seen > BOX_FRESH_SEC) return null;
  try {
    return JSON.parse(r.caps) as BoxCaps;
  } catch {
    return null;
  }
}

/**
 * Queue a command the gateway itself originates (an answer to a radio command) for a box. These kinds
 * are never accepted from the enqueue API: only the gateway may ask a box to transmit on the service
 * call's behalf, and the box still applies its own transmit gates.
 */
export async function enqueueSystemBoxCommand(
  env: Env,
  boxId: string,
  kind: "aprs_msg" | "meshcom_msg",
  payload: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO box_commands (box_id, callsign, kind, payload, status, created_at) VALUES (?, NULL, ?, ?, 'queued', ?)",
  )
    .bind(boxId, kind, JSON.stringify(payload), now())
    .run();
}

/** GET /api/box/:id/commands — the box leases its queued commands (and they're marked sent). */
export async function handleBoxPoll(req: Request, env: Env, boxId: string): Promise<Response> {
  if (!boxAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  if (url.searchParams.has("tx"))
    await env.DB.prepare(
      `INSERT INTO box_status (box_id, caps, last_seen) VALUES (?,?,?)
       ON CONFLICT(box_id) DO UPDATE SET caps = excluded.caps, last_seen = excluded.last_seen`,
    )
      .bind(boxId, JSON.stringify(parseBoxCaps(url)), now())
      .run();
  const rows = (
    await env.DB.prepare(
      "SELECT id, callsign, kind, payload, sig, created_at AS createdAt FROM box_commands WHERE box_id = ? AND status = 'queued' ORDER BY created_at LIMIT 50",
    )
      .bind(boxId)
      .all<{ id: number; payload: string | null }>()
  ).results;
  if (rows.length) {
    const t = now();
    await env.DB.batch(
      rows.map((r) => env.DB.prepare("UPDATE box_commands SET status='sent', sent_at=? WHERE id=?").bind(t, r.id)),
    );
  }
  return json({ commands: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
}

/** POST /api/box/:id/commands/ack — the box reports execution. */
export async function handleBoxAck(req: Request, env: Env, boxId: string): Promise<Response> {
  if (!boxAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const { id, status, result } = (await req.json().catch(() => ({}))) as {
    id?: number;
    status?: string;
    result?: string;
  };
  if (!id || (status !== "done" && status !== "failed"))
    return json({ error: "id and status (done|failed) required" }, { status: 400 });
  await env.DB.prepare("UPDATE box_commands SET status=?, result=?, acked_at=? WHERE id=? AND box_id=?")
    .bind(status, result ?? null, now(), id, boxId)
    .run();
  return json({ ok: true });
}

/** GET /api/box/:id/log — operator view of recent commands + their status. */
export async function handleBoxLog(req: Request, env: Env, boxId: string): Promise<Response> {
  const me = await sessionAccountId(req, env);
  const trusted = boxAuth(req, env);
  if (!me && !trusted) return json({ error: "sign in to view box activity" }, { status: 401 });
  // a box's activity is visible only to its owner (or the trusted backend). An unclaimed
  // box has no owner yet → only the box secret can read it until someone claims it by controlling it.
  if (me && !trusted) {
    const row = await env.DB.prepare("SELECT account_id FROM boxes WHERE box_id = ?")
      .bind(boxId)
      .first<{ account_id: string }>();
    if (!row || row.account_id !== me.accountId)
      return json({ error: "this box belongs to another operator" }, { status: 403 });
  }
  const rows = (
    await env.DB.prepare(
      "SELECT id, callsign, kind, payload, status, result, created_at AS createdAt, sent_at AS sentAt, acked_at AS ackedAt FROM box_commands WHERE box_id = ? ORDER BY created_at DESC LIMIT 50",
    )
      .bind(boxId)
      .all<{ payload: string | null }>()
  ).results;
  return json({ boxId, commands: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
}
