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
 *   POST /api/box/:id/pair            the box obtains a one-time pairing code (x-ingest-secret) and shows it
 *   POST /api/box/:id/claim {code}    a signed-in operator links the box to their account with that code
 *
 * A box belongs to the account that presented a pairing code the box itself obtained — proof of
 * possession of the box (its ingest secret) — so no account can take a box id by touching it first.
 *
 * Gating (non-negotiable): every TX-capable command requires a callsign gated on control-verification;
 * RX-only boxes simply never receive TX kinds. This is operator→own-box control, distinct
 * from the federation/APRS service identity.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionIdentity, accountHoldsCall, ingestOrBoxOk, timingSafeEqual } from "./auth.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { isCallsignVerified } from "./callsign.js";
import { serviceCall } from "./servicecall.js";
import { boxPrincipal } from "./boxprincipal.js";
import { BOX_COMMAND_QUEUED_TTL_S } from "./retention.js";

const TX_KINDS = new Set(["beacon", "message", "wx_beacon", "igate", "digi", "tx"]);
const ALL_KINDS = new Set([...TX_KINDS, "status"]);
const boxAuth = ingestOrBoxOk;

/** Is `accountId` the paired owner of `boxId`? An unpaired box has no owner and takes no session commands. */
async function ownsBox(env: Env, boxId: string, accountId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT account_id FROM boxes WHERE box_id = ?")
    .bind(boxId)
    .first<{ account_id: string }>();
  return row?.account_id === accountId;
}

/** A pairing code is good for 15 minutes — long enough to read it off the box and type it in. */
const PAIR_TTL_SEC = 15 * 60;
/** Claim attempts per box per window: a code has 40 bits, and guesses are capped besides. */
const CLAIM_ATTEMPTS = 10;
const CLAIM_WINDOW_MS = 15 * 60_000;
/** Upper-case letters and digits without the look-alikes 0/O and 1/I: 32 symbols, 5 bits each. */
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newPairCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => PAIR_ALPHABET[b % 32]!).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
async function codeHash(boxId: string, code: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${boxId}|${normCode(code)}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * POST /api/box/:id/pair — the box asks for a pairing code with its ingest secret and prints it for its
 * operator. A new code replaces any earlier one. Only a hash is stored.
 */
export async function handleBoxPair(req: Request, env: Env, boxId: string): Promise<Response> {
  if (!boxAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const code = newPairCode();
  const expiresAt = nowS() + PAIR_TTL_SEC;
  await env.DB.prepare(
    `INSERT INTO box_pairings (box_id, code_hash, expires_at) VALUES (?,?,?)
     ON CONFLICT(box_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
  )
    .bind(boxId, await codeHash(boxId, code), expiresAt)
    .run();
  return json({ boxId, code, expiresAt });
}

/**
 * POST /api/box/:id/claim {code} — link the box to the signed-in account. The code is single-use; a
 * valid one also moves a box that was paired to another account (whoever holds the box decides).
 */
export async function handleBoxClaim(req: Request, env: Env, boxId: string): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to pair a box" }, { status: 401 });
  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!code || normCode(code).length !== 8)
    return json({ error: "enter the 8-character code the box shows" }, { status: 400 });
  if (await rateLimitedDurable(env, `boxclaim:${boxId}`, Date.now(), CLAIM_ATTEMPTS, CLAIM_WINDOW_MS))
    return json({ error: "too many pairing attempts — wait, then use a fresh code from the box" }, { status: 429 });
  const row = await env.DB.prepare("SELECT code_hash, expires_at FROM box_pairings WHERE box_id = ?")
    .bind(boxId)
    .first<{ code_hash: string; expires_at: number }>();
  const good = !!row && row.expires_at > nowS() && timingSafeEqual(row.code_hash, await codeHash(boxId, code));
  if (!good)
    return json(
      { error: "that pairing code is wrong or expired — restart the ingest box for a fresh one" },
      { status: 403 },
    );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM box_pairings WHERE box_id = ?").bind(boxId),
    env.DB.prepare(
      `INSERT INTO boxes (box_id, account_id, created_at) VALUES (?,?,?)
       ON CONFLICT(box_id) DO UPDATE SET account_id = excluded.account_id, created_at = excluded.created_at`,
    ).bind(boxId, me.accountId, nowS()),
  ]);
  return json({ ok: true, boxId });
}

const unpaired = () =>
  json(
    { error: "pair this box first: enter the pairing code the ingest box prints at start", pair: true },
    { status: 403 },
  );

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
  const me = await sessionIdentity(req, env);
  const trusted = boxAuth(req, env);
  if (!me && !trusted) return json({ error: "sign in (or provide the box secret) to control a box" }, { status: 401 });
  if (me && !trusted && !(await ownsBox(env, boxId, me.accountId))) return unpaired();
  // A session may only transmit as a callsign its own account holds; the trusted backend may name any.
  const callsign = (body.callsign ?? me?.callsign ?? "").toUpperCase();
  if (TX_KINDS.has(kind)) {
    // a box's own key queues a transmission only on a box the sysop lets run this instance's services
    const p = boxPrincipal(req);
    if (p && !me && !p.services)
      return json(
        { error: "this box does not run this instance's services, so it cannot queue a transmission" },
        { status: 403 },
      );
    if (!callsign) return json({ error: "a licensed callsign is required to transmit" }, { status: 400 });
    if (me && !trusted && !(await accountHoldsCall(env, me.accountId, callsign)))
      return json({ error: `${callsign} is not held by your account` }, { status: 403 });
    if (!(await isCallsignVerified(env, callsign)))
      return json({ error: `verify ${callsign} to transmit — control-verification required` }, { status: 403 });
  }

  const ins = await env.DB.prepare(
    "INSERT INTO box_commands (box_id, callsign, kind, payload, sig, status, created_at) VALUES (?,?,?,?,?, 'queued', ?)",
  )
    .bind(boxId, callsign, kind, body.payload != null ? JSON.stringify(body.payload) : null, body.sig ?? null, nowS())
    .run();
  return json(
    { id: Number(ins.meta.last_row_id), boxId, kind, callsign, status: "queued", tx: TX_KINDS.has(kind) },
    { status: 201 },
  );
}

/** What a box reported it can transmit on its last poll. */
interface BoxCaps {
  tx: boolean;
  rf: boolean;
  meshcom: string[];
  /** The MeshCom nodes the box reaches over KISS, which send from the service call and report its acks. */
  kiss?: string[];
}

/** Parse the capability report a box sends with its poll (`?tx=1&rf=1&meshcom=CALL,…`). */
function parseBoxCaps(url: URL): BoxCaps {
  const meshcom = (url.searchParams.get("meshcom") ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$/.test(c))
    .slice(0, 8);
  const kiss = (url.searchParams.get("kiss") ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => meshcom.includes(c));
  return { tx: url.searchParams.get("tx") === "1", rf: url.searchParams.get("rf") === "1", meshcom, kiss };
}

/** A box that polled within this many seconds is considered reachable for a reply. */
const BOX_FRESH_SEC = 120;

/** The box's last capability report, or null when it has not polled recently. */
export async function freshBoxCaps(env: Env, boxId: string): Promise<BoxCaps | null> {
  const r = await env.DB.prepare("SELECT caps, last_seen FROM box_status WHERE box_id = ?")
    .bind(boxId)
    .first<{ caps: string; last_seen: number }>();
  if (!r || nowS() - r.last_seen > BOX_FRESH_SEC) return null;
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
    .bind(boxId, kind, JSON.stringify(payload), nowS())
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
      .bind(boxId, JSON.stringify(parseBoxCaps(url)), nowS())
      .run();
  const stale = nowS() - BOX_COMMAND_QUEUED_TTL_S;
  await env.DB.prepare(
    "UPDATE box_commands SET status='expired', result='not collected in time' WHERE box_id = ? AND status = 'queued' AND created_at < ?",
  )
    .bind(boxId, stale)
    .run();
  const rows = (
    await env.DB.prepare(
      "SELECT id, callsign, kind, payload, sig, created_at AS createdAt FROM box_commands WHERE box_id = ? AND status = 'queued' AND created_at >= ? ORDER BY created_at LIMIT 50",
    )
      .bind(boxId, stale)
      .all<{ id: number; payload: string | null }>()
  ).results;
  if (rows.length) {
    const t = nowS();
    await env.DB.batch(
      rows.map((r) => env.DB.prepare("UPDATE box_commands SET status='sent', sent_at=? WHERE id=?").bind(t, r.id)),
    );
  }
  return json({
    serviceCall: serviceCall(env),
    commands: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })),
  });
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
  const done = await env.DB.prepare(
    "UPDATE box_commands SET status=?, result=?, acked_at=? WHERE id=? AND box_id=? AND status != 'done'",
  )
    .bind(status, result ?? null, nowS(), id, boxId)
    .run();
  // A message the box transmitted shows in the Messages list as sent, once however often the box reports it.
  // The box sends a message on its TNC.
  if (status === "done" && done.meta.changes) {
    const cmd = await env.DB.prepare("SELECT callsign, kind, payload FROM box_commands WHERE id=?")
      .bind(id)
      .first<{ callsign: string | null; kind: string; payload: string | null }>();
    const p =
      cmd?.kind === "message" && cmd.payload ? (JSON.parse(cmd.payload) as { to?: string; text?: string }) : null;
    if (cmd?.callsign && p?.to && p.text)
      await env.DB.prepare(
        "INSERT INTO messages (ts, from_call, to_call, body, direction, transport) VALUES (?,?,?,?, 'tx', 'tnc')",
      )
        .bind(nowS(), cmd.callsign.toUpperCase(), p.to.toUpperCase(), p.text)
        .run();
  }
  return json({ ok: true });
}

/** GET /api/box/:id/log — operator view of recent commands + their status. */
export async function handleBoxLog(req: Request, env: Env, boxId: string): Promise<Response> {
  const me = await sessionIdentity(req, env);
  const trusted = boxAuth(req, env);
  if (!me && !trusted) return json({ error: "sign in to view box activity" }, { status: 401 });
  // a box's activity is visible only to its paired owner (or the box secret)
  if (me && !trusted && !(await ownsBox(env, boxId, me.accountId))) return unpaired();
  const rows = (
    await env.DB.prepare(
      "SELECT id, callsign, kind, payload, status, result, created_at AS createdAt, sent_at AS sentAt, acked_at AS ackedAt FROM box_commands WHERE box_id = ? ORDER BY created_at DESC LIMIT 50",
    )
      .bind(boxId)
      .all<{ payload: string | null }>()
  ).results;
  return json({ boxId, commands: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
}
