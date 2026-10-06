// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedpacket.ts — the gateway's side of federation pull over packet circuits. The circuit runs on the operator's
 * ingest box (ingest-locality): the box asks here which peers publish an `ax25` or `netrom` endpoint and where
 * its last session with each stopped, dials one, delivers the pages to `POST /federation/frames` (where every
 * frame is checked against its origin's key, as any pulled page), and reports the session back here. The report
 * moves the packet path's own cursors and its status, which Instance admin shows beside the peer. A feed of the
 * peer's own records resumes from what this gateway holds of the peer by any path when that is further
 * (fedtransit.ts marks), so a record an http pull or a hub brought costs no airtime.
 *
 * Both endpoints take the ingest credential (or the operator's). A report carries no records and grants
 * nothing: the worst a forged one does is make the next session re-read a feed, which applies idempotently.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { requireIngestOrOperator } from "./admin.js";
import { storedEndpoints } from "./fedtransport.js";
import { markOf, ORIGIN_KINDS } from "./fedtransit.js";

/** The feeds a packet session pulls; a cursor for anything else is dropped. */
const PACKET_FEEDS = new Set(["tombstone", "cache", "find", "key", "account-move", "bulletin"]);
const PACKET_TRANSPORTS = new Set(["ax25", "netrom"]);

interface FeedCursor {
  since: number;
  sinceId?: number;
}

function parseCursors(raw: unknown): Record<string, FeedCursor> {
  let v = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const out: Record<string, FeedCursor> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [feed, c] of Object.entries(v as Record<string, unknown>)) {
    if (!PACKET_FEEDS.has(feed) || !c || typeof c !== "object") continue;
    const { since, sinceId } = c as { since?: unknown; sinceId?: unknown };
    if (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0) continue;
    out[feed] = { since, ...(typeof sinceId === "number" && Number.isSafeInteger(sinceId) && { sinceId }) };
  }
  return out;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/**
 * GET /federation/packet/peers — the peers the ingest box may pull over packet: enabled, not blocked, with at
 * least one `ax25` or `netrom` endpoint, longest-waiting first, each with its packet cursors. The top-level
 * counts (`total`, `failing`, `never`) are what `doctor` reports.
 */
export async function handlePacketPeers(req: Request, env: Env): Promise<Response> {
  const denied = await requireIngestOrOperator(req, env);
  if (denied) return denied;
  const rows = (
    await env.DB.prepare(
      `SELECT p.instance, p.endpoints, s.cursors, s.transport, s.address, s.last_attempt, s.last_ok, s.last_error
         FROM fed_peers p LEFT JOIN fed_packet_sync s ON s.instance = p.instance
        WHERE p.trust != 'blocked' AND p.enabled = 1 AND p.instance IS NOT NULL AND p.endpoints IS NOT NULL
        ORDER BY COALESCE(s.last_attempt, 0), p.instance`,
    ).all<{
      instance: string;
      endpoints: string;
      cursors: string | null;
      transport: string | null;
      address: string | null;
      last_attempt: number | null;
      last_ok: number | null;
      last_error: string | null;
    }>()
  ).results;
  const peers = [];
  for (const r of rows) {
    const endpoints = storedEndpoints(r.endpoints)
      .filter((e) => PACKET_TRANSPORTS.has(e.transport))
      .map((e) => ({ transport: e.transport, address: e.address }));
    if (!endpoints.length) continue;
    // a feed of the peer's own records starts at what this gateway already holds of it, by any path, when that
    // is further: airtime is not spent on records an http pull or a hub brought
    const cursors = parseCursors(r.cursors);
    for (const kind of ORIGIN_KINDS) {
      const held = await markOf(env, r.instance, kind);
      if (held > (cursors[kind]?.since ?? 0)) cursors[kind] = { since: held };
    }
    peers.push({
      instance: r.instance,
      endpoints,
      cursors,
      lastAttempt: r.last_attempt,
      lastOk: r.last_ok,
      lastError: r.last_error,
    });
  }
  const failing = peers.filter((p) => p.lastError).length; // a session that completes clears the error
  const never = peers.filter((p) => !p.lastOk).length;
  return json({ total: peers.length, failing, never, peers });
}

/**
 * POST /federation/packet/status — the ingest box reports one packet session: the endpoint it dialled, whether
 * the session completed, the page and record counts, and the feeds' new positions. Only a known, unblocked
 * peer has a status.
 */
export async function handlePacketStatus(req: Request, env: Env): Promise<Response> {
  const denied = await requireIngestOrOperator(req, env);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const instance = typeof b?.instance === "string" ? b.instance : "";
  const transport = typeof b?.transport === "string" && PACKET_TRANSPORTS.has(b.transport) ? b.transport : null;
  const address = typeof b?.address === "string" ? b.address.slice(0, 200) : null;
  if (!b || !instance || !transport || !address)
    return json({ error: "instance, transport (ax25 or netrom) and address are required" }, { status: 400 });
  const peer = await env.DB.prepare("SELECT 1 AS ok FROM fed_peers WHERE instance = ? AND trust != 'blocked'")
    .bind(instance)
    .first<{ ok: number }>();
  if (!peer) return json({ error: `${instance} is not a peer here` }, { status: 404 });
  const ok = b.ok === true;
  const error = ok ? null : typeof b.error === "string" ? b.error.slice(0, 300) : "session failed";
  const counts = {
    pages: count(b.pages),
    frames: count(b.frames),
    applied: count(b.applied),
    quarantined: count(b.quarantined),
    rejected: count(b.rejected),
    complete: b.complete === true,
  };
  const prev = await env.DB.prepare("SELECT cursors FROM fed_packet_sync WHERE instance = ?")
    .bind(instance)
    .first<{ cursors: string | null }>();
  const cursors = { ...parseCursors(prev?.cursors ?? null), ...parseCursors(b.cursors) };
  const at = nowS();
  await env.DB.prepare(
    `INSERT INTO fed_packet_sync (instance, transport, address, last_attempt, last_ok, last_error, sessions_ok,
                                  sessions_err, last_counts, cursors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance) DO UPDATE SET transport = excluded.transport, address = excluded.address,
       last_attempt = excluded.last_attempt, last_ok = COALESCE(excluded.last_ok, fed_packet_sync.last_ok),
       last_error = excluded.last_error, sessions_ok = fed_packet_sync.sessions_ok + excluded.sessions_ok,
       sessions_err = fed_packet_sync.sessions_err + excluded.sessions_err, last_counts = excluded.last_counts,
       cursors = excluded.cursors`,
  )
    .bind(
      instance,
      transport,
      address,
      at,
      ok ? at : null,
      error,
      ok ? 1 : 0,
      ok ? 0 : 1,
      JSON.stringify(counts),
      JSON.stringify(cursors),
    )
    .run();
  return json({ ok: true });
}
