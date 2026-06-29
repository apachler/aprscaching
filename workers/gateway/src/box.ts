/**
 * box.ts — remote control of an operator's own ingest box (docs/20 §2, R1). The web app enqueues
 * commands; the box pulls them over its existing outbound connection (no inbound ports), executes,
 * and acks. The ECHOCAT pattern with the gateway as the rendezvous.
 *
 *   POST /api/box/:id/command         enqueue (session or box secret; TX kinds are control-verified)
 *   GET  /api/box/:id/commands        the box leases queued commands (x-ingest-secret) → marks them sent
 *   POST /api/box/:id/commands/ack    the box reports done/failed (x-ingest-secret)
 *   GET  /api/box/:id/log             operator view of recent commands + status (session or secret)
 *
 * Gating (non-negotiable, docs/16 H5 + docs/19): every TX-capable command requires a *verified*
 * callsign; RX-only boxes simply never receive TX kinds. This is operator→own-box control, distinct
 * from the federation/APRS service identity.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { actor } from "./caches.js";
import { sessionCallsign } from "./auth.js";

const TX_KINDS = new Set(["beacon", "message", "wx_beacon", "igate", "digi", "tx"]);
const ALL_KINDS = new Set([...TX_KINDS, "status"]);
const now = () => Math.floor(Date.now() / 1000);
const boxAuth = (req: Request, env: Env) => (req.headers.get("x-ingest-secret") ?? "") === env.INGEST_SECRET;

async function isVerified(env: Env, call: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM callsign_verifications WHERE callsign = ? AND status = 'verified'").bind(call.toUpperCase()).first();
  return !!r;
}

/** POST /api/box/:id/command — the operator enqueues a command for their box. */
export async function handleBoxEnqueue(req: Request, env: Env, boxId: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { kind?: string; payload?: unknown; callsign?: string; sig?: string };
  const kind = String(body.kind ?? "").toLowerCase();
  if (!ALL_KINDS.has(kind)) return json({ error: `unknown command kind; one of ${[...ALL_KINDS].join(", ")}` }, { status: 400 });
  // authorize: a signed-in operator session, or the box secret (trusted backend). Read commands need
  // no callsign; TX commands require a verified one (control-verification, H5).
  const sess = await sessionCallsign(req, env);
  if (!sess && !boxAuth(req, env)) return json({ error: "sign in (or provide the box secret) to control a box" }, { status: 401 });
  const callsign = (body.callsign ?? sess ?? "").toUpperCase();
  if (TX_KINDS.has(kind)) {
    if (!callsign) return json({ error: "a licensed callsign is required to transmit" }, { status: 400 });
    if (!(await isVerified(env, callsign))) return json({ error: `verify ${callsign} to transmit — control-verification required (H5)` }, { status: 403 });
  }

  const ins = await env.DB.prepare(
    "INSERT INTO box_commands (box_id, callsign, kind, payload, sig, status, created_at) VALUES (?,?,?,?,?, 'queued', ?)",
  ).bind(boxId, callsign, kind, body.payload != null ? JSON.stringify(body.payload) : null, body.sig ?? null, now()).run();
  return json({ id: Number(ins.meta.last_row_id), boxId, kind, callsign, status: "queued", tx: TX_KINDS.has(kind) }, { status: 201 });
}

/** GET /api/box/:id/commands — the box leases its queued commands (and they're marked sent). */
export async function handleBoxPoll(req: Request, env: Env, boxId: string): Promise<Response> {
  if (!boxAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const rows = (await env.DB.prepare(
    "SELECT id, callsign, kind, payload, sig, created_at AS createdAt FROM box_commands WHERE box_id = ? AND status = 'queued' ORDER BY created_at LIMIT 50",
  ).bind(boxId).all<{ id: number; payload: string | null }>()).results;
  if (rows.length) {
    const t = now();
    await env.DB.batch(rows.map((r) => env.DB.prepare("UPDATE box_commands SET status='sent', sent_at=? WHERE id=?").bind(t, r.id)));
  }
  return json({ commands: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
}

/** POST /api/box/:id/commands/ack — the box reports execution. */
export async function handleBoxAck(req: Request, env: Env, boxId: string): Promise<Response> {
  if (!boxAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const { id, status, result } = (await req.json().catch(() => ({}))) as { id?: number; status?: string; result?: string };
  if (!id || (status !== "done" && status !== "failed")) return json({ error: "id and status (done|failed) required" }, { status: 400 });
  await env.DB.prepare("UPDATE box_commands SET status=?, result=?, acked_at=? WHERE id=? AND box_id=?")
    .bind(status, result ?? null, now(), id, boxId).run();
  return json({ ok: true });
}

/** GET /api/box/:id/log — operator view of recent commands + their status (for the R2 UI). */
export async function handleBoxLog(req: Request, env: Env, boxId: string): Promise<Response> {
  const who = await actor(req, env);
  if (!who && !boxAuth(req, env)) return json({ error: "sign in to view box activity" }, { status: 401 });
  const rows = (await env.DB.prepare(
    "SELECT id, callsign, kind, payload, status, result, created_at AS createdAt, sent_at AS sentAt, acked_at AS ackedAt FROM box_commands WHERE box_id = ? ORDER BY created_at DESC LIMIT 50",
  ).bind(boxId).all<{ payload: string | null }>()).results;
  return json({ boxId, commands: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
}
