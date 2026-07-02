// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * relay.ts — federation rendezvous relay (docs/15 T2.3 path 2). Lets a NAT'd / firewalled peer that
 * cannot be dialled inbound STILL serve its feed to the commons, by reusing the **poll-based rendezvous
 * seam** the remote-control box already uses (box.ts — the ECHOCAT pattern), NOT a persistent WebSocket.
 * That keeps it tri-runtime-clean (plain D1 + HTTP, no runtime-divergent socket infra):
 *
 *   A requester enqueues a relay query FOR a spoke instance  → POST /federation/relay/:instance/query
 *   The spoke leases queries addressed to it (over its own outbound poll) → GET  /federation/relay/lease
 *   The spoke answers each from its OWN DB and posts the result back      → POST /federation/relay/answer
 *   The requester collects the answer                                     → GET  /federation/relay/result/:id
 *
 * Trust is unchanged: a relayed answer is a signed feed page, verified exactly like a pulled one — the
 * relay is pure transport (docs/22 "transport convenience ≠ trust uplift"). The spoke answers `feed`
 * queries in v1 (restoring downstream re-serving of a firewalled peer's feed); `corroborate` is a
 * reserved kind (live cross-instance quorum is the deploy-gated extension). Gated by `FED_RELAY_SECRET`.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { buildFeed, CACHE_FEED, FIND_FEED, KEY_FEED, type FeedServeDef } from "./federation.js";

export type RelayKind = "feed" | "corroborate";
export interface ParsedRelayQuery { kind: RelayKind; params: Record<string, unknown> }
export interface RelayResult { ok: boolean; kind: RelayKind; data?: unknown; error?: string }

/** The feeds a spoke may serve over the relay, by name (same signed records as pull-sync / push-to-hub). */
const FEEDS: Record<string, FeedServeDef> = { caches: CACHE_FEED, finds: FIND_FEED, keys: KEY_FEED };

const now = () => Math.floor(Date.now() / 1000);
const relayAuth = (req: Request, env: Env): boolean => {
  const s = env.FED_RELAY_SECRET;
  return !!s && (req.headers.get("x-relay-secret") ?? "") === s;
};

/** PURE: validate an untrusted relay-query body into a known kind + params, or null. */
export function parseRelayQuery(raw: unknown): ParsedRelayQuery | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind !== "feed" && kind !== "corroborate") return null;
  const params = (raw as { params?: unknown }).params;
  if (params != null && typeof params !== "object") return null;
  return { kind, params: (params as Record<string, unknown>) ?? {} };
}

/**
 * PURE: answer a relay query from injected sources — the dispatch core, testable without HTTP or a DB.
 * A source may be absent (e.g. no corroborator at this instance) → a clean `ok:false` rather than a throw.
 */
export async function answerRelayQuery(
  q: ParsedRelayQuery,
  sources: { feed?: (p: Record<string, unknown>) => Promise<unknown>; corroborate?: (p: Record<string, unknown>) => Promise<unknown> },
): Promise<RelayResult> {
  try {
    const fn = q.kind === "feed" ? sources.feed : sources.corroborate;
    if (!fn) return { ok: false, kind: q.kind, error: `${q.kind} not supported at this instance` };
    return { ok: true, kind: q.kind, data: await fn(q.params) };
  } catch (e) {
    return { ok: false, kind: q.kind, error: (e as Error).message };
  }
}

/** The spoke's real feed source: build a signed feed page for `params.feed` from `params.since`. */
async function feedSource(env: Env, params: Record<string, unknown>): Promise<unknown> {
  const name = String(params.feed ?? "caches");
  const def = FEEDS[name];
  if (!def) throw new Error(`unknown feed '${name}'`);
  const since = Math.max(0, Number(params.since ?? 0) || 0);
  const limit = Math.min(Math.max(Number(params.limit ?? 200) || 200, 1), 1000);
  const built = await buildFeed(env, env.INSTANCE ?? "local", def, since, limit);
  return { feed: name, since, ...built };
}

// ------------------------------------------------------------------ hub-side endpoints
/** POST /federation/relay/:instance/query — a requester enqueues a relay query for a spoke instance. */
export async function handleRelayEnqueue(req: Request, env: Env, instance: string): Promise<Response> {
  if (!relayAuth(req, env)) return json({ error: "relay disabled or bad secret" }, { status: 401 });
  const q = parseRelayQuery(await req.json().catch(() => null));
  if (!q) return json({ error: "kind (feed|corroborate) required" }, { status: 400 });
  const ins = await env.DB.prepare(
    "INSERT INTO fed_relay_queue (instance, kind, params, status, created_at) VALUES (?,?,?, 'queued', ?)",
  ).bind(instance.toLowerCase(), q.kind, JSON.stringify(q.params), now()).run();
  return json({ id: Number(ins.meta.last_row_id), instance, kind: q.kind, status: "queued" }, { status: 201 });
}

/** GET /federation/relay/lease?instance=SELF — the spoke leases queries addressed to it. */
export async function handleRelayLease(req: Request, env: Env): Promise<Response> {
  if (!relayAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const instance = (new URL(req.url).searchParams.get("instance") ?? env.INSTANCE ?? "").toLowerCase();
  if (!instance) return json({ error: "instance required" }, { status: 400 });
  const rows = (await env.DB.prepare(
    "SELECT id, kind, params FROM fed_relay_queue WHERE instance = ? AND status = 'queued' ORDER BY created_at LIMIT 25",
  ).bind(instance).all<{ id: number; kind: string; params: string }>()).results;
  if (rows.length) {
    const t = now();
    await env.DB.batch(rows.map((r) => env.DB.prepare("UPDATE fed_relay_queue SET status='leased', leased_at=? WHERE id=?").bind(t, r.id)));
  }
  return json({ queries: rows.map((r) => ({ id: r.id, kind: r.kind, params: JSON.parse(r.params) })) });
}

/** POST /federation/relay/answer — the spoke posts a result for a leased query. */
export async function handleRelayAnswer(req: Request, env: Env): Promise<Response> {
  if (!relayAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const { id, result } = (await req.json().catch(() => ({}))) as { id?: number; result?: RelayResult };
  if (!id || !result) return json({ error: "id and result required" }, { status: 400 });
  await env.DB.prepare("UPDATE fed_relay_queue SET status='answered', answer=?, answered_at=? WHERE id=? AND status='leased'")
    .bind(JSON.stringify(result), now(), id).run();
  return json({ ok: true });
}

/** GET /federation/relay/result/:id — the requester polls for the spoke's answer. */
export async function handleRelayResult(req: Request, env: Env, id: string): Promise<Response> {
  if (!relayAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const row = await env.DB.prepare("SELECT status, answer FROM fed_relay_queue WHERE id = ?").bind(Number(id)).first<{ status: string; answer: string | null }>();
  if (!row) return json({ error: "no such query" }, { status: 404 });
  return json({ status: row.status, answer: row.answer ? JSON.parse(row.answer) : null });
}

// ------------------------------------------------------------------ spoke-side poller
/**
 * A NAT'd spoke leases relay queries from its hub and answers them from its own DB. Run from `runScheduled`;
 * a no-op unless both `FED_HUB_URL` and `FED_RELAY_SECRET` are set. This is the outbound-only leg that makes
 * a firewalled peer's feed reachable through the hub.
 */
export async function relayPoll(env: Env): Promise<void> {
  const hub = env.FED_HUB_URL, secret = env.FED_RELAY_SECRET;
  if (!hub || !secret) return;
  const h = { "content-type": "application/json", "x-relay-secret": secret };
  const leaseRes = await fetch(`${hub}/federation/relay/lease?instance=${encodeURIComponent(env.INSTANCE ?? "")}`, { headers: h });
  if (!leaseRes.ok) return;
  const { queries } = (await leaseRes.json().catch(() => ({ queries: [] }))) as { queries: { id: number; kind: RelayKind; params: Record<string, unknown> }[] };
  for (const q of queries ?? []) {
    const result = await answerRelayQuery({ kind: q.kind, params: q.params ?? {} }, { feed: (p) => feedSource(env, p) });
    await fetch(`${hub}/federation/relay/answer`, { method: "POST", headers: h, body: JSON.stringify({ id: q.id, result }) }).catch(() => {});
  }
}
