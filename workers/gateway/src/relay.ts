// SPDX-License-Identifier: AGPL-3.0-or-later
import { secretOk } from "./auth.js";
/**
 * relay.ts — federation rendezvous relay. Lets a NAT'd / firewalled peer that
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
 * relay is pure transport. The spoke answers `feed`
 * queries (downstream re-serving of a firewalled peer's feed); `corroborate` is a
 * reserved kind (live cross-instance quorum is the deploy-gated extension). Gated by `FED_RELAY_SECRET`.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { buildFeed, CACHE_FEED, FIND_FEED, KEY_FEED, type FeedServeDef } from "./federation.js";
import { signFedRecord } from "./fedcbor.js";
import { enqueueAcsfedBulletin } from "./fedforward.js";
import { buildFedFrames, encodeFedSyncPage } from "./fedsync.js";

export type RelayKind = "feed" | "corroborate";
export interface ParsedRelayQuery {
  kind: RelayKind;
  params: Record<string, unknown>;
}
export interface RelayResult {
  ok: boolean;
  kind: RelayKind;
  data?: unknown;
  error?: string;
}

/** The feeds a spoke may serve over the relay, by name (same signed records as pull-sync / push-to-hub). */
const FEEDS: Record<string, FeedServeDef> = { caches: CACHE_FEED, finds: FIND_FEED, keys: KEY_FEED };

const now = () => Math.floor(Date.now() / 1000);
const relayAuth = (req: Request, env: Env): boolean => {
  const s = env.FED_RELAY_SECRET;
  return secretOk(req.headers.get("x-relay-secret"), s);
};

/**
 * A spoke must only be able to lease/answer queries addressed to ITS OWN instance. The flat
 * `x-relay-secret` alone would let any secret-holder pass `?instance=other` and drain another spoke's queue.
 * Bind the credential to the instance with a per-spoke token = HMAC(FED_RELAY_SECRET, "relay-spoke:<instance>").
 * The spoke derives the same token from the shared secret; no extra config or table needed.
 */
export async function relaySpokeToken(env: Env, instance: string): Promise<string | null> {
  const secret = env.FED_RELAY_SECRET;
  if (!secret) return null;
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`relay-spoke:${instance.toLowerCase()}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function spokeAuth(req: Request, env: Env, instance: string): Promise<boolean> {
  if (!instance) return false;
  const expected = await relaySpokeToken(env, instance);
  return expected != null && secretOk(req.headers.get("x-relay-token"), expected);
}

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
  sources: {
    feed?: (p: Record<string, unknown>) => Promise<unknown>;
    corroborate?: (p: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<RelayResult> {
  try {
    const fn = q.kind === "feed" ? sources.feed : sources.corroborate;
    if (!fn) return { ok: false, kind: q.kind, error: `${q.kind} not supported at this instance` };
    return { ok: true, kind: q.kind, data: await fn(q.params) };
  } catch (e) {
    return { ok: false, kind: q.kind, error: (e as Error).message };
  }
}

/** Relay feed name → the sync feed type the CBOR producer speaks. */
const SYNC_TYPE_BY_FEED: Record<string, string> = { caches: "cache", finds: "find", keys: "key" };

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x4000) s += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(s);
};

/**
 * The spoke's real feed source: build a signed feed page for `params.feed` from `params.since`.
 * `encoding: "cbor"` answers with a base64 fedwire sync page instead of the JSON items — the same
 * signed frames as every other carrier, so per-record JSON signatures aren't needed on that path.
 */
export async function feedSource(env: Env, params: Record<string, unknown>): Promise<unknown> {
  const name = typeof params.feed === "string" ? params.feed : "caches";
  const def = FEEDS[name];
  if (!def) throw new Error(`unknown feed '${name}'`);
  const since = Math.max(0, Number(params.since ?? 0) || 0);
  const limit = Math.min(Math.max(Number(params.limit ?? 200) || 200, 1), 1000);
  const instance = env.INSTANCE ?? "local";
  if (params.encoding === "cbor") {
    const built = await buildFedFrames(env, instance, SYNC_TYPE_BY_FEED[name]!, since, limit);
    if (!built) throw new Error("instance is unsigned — no CBOR frames");
    return {
      feed: name,
      since,
      encoding: "cbor",
      nextCursor: built.nextCursor,
      complete: built.frames.length < limit,
      pageB64: b64(encodeFedSyncPage(instance, built.nextCursor, built.frames.length < limit, built.frames)),
    };
  }
  const built = await buildFeed(env, instance, def, since, limit);
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
  )
    .bind(instance.toLowerCase(), q.kind, JSON.stringify(q.params), now())
    .run();
  return json({ id: Number(ins.meta.last_row_id), instance, kind: q.kind, status: "queued" }, { status: 201 });
}

/** GET /federation/relay/lease?instance=SELF — the spoke leases queries addressed to it. */
export async function handleRelayLease(req: Request, env: Env): Promise<Response> {
  const instance = (new URL(req.url).searchParams.get("instance") ?? env.INSTANCE ?? "").toLowerCase();
  if (!instance) return json({ error: "instance required" }, { status: 400 });
  // A spoke may only lease queries for its own instance (per-spoke token), not any it names.
  if (!(await spokeAuth(req, env, instance))) return new Response("unauthorized", { status: 401 });
  const rows = (
    await env.DB.prepare(
      "SELECT id, kind, params FROM fed_relay_queue WHERE instance = ? AND status = 'queued' ORDER BY created_at LIMIT 25",
    )
      .bind(instance)
      .all<{ id: number; kind: string; params: string }>()
  ).results;
  if (rows.length) {
    const t = now();
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare("UPDATE fed_relay_queue SET status='leased', leased_at=? WHERE id=?").bind(t, r.id),
      ),
    );
  }
  return json({ queries: rows.map((r) => ({ id: r.id, kind: r.kind, params: JSON.parse(r.params) })) });
}

/** POST /federation/relay/answer — the spoke posts a result for a leased query. */
export async function handleRelayAnswer(req: Request, env: Env): Promise<Response> {
  const { id, result, instance } = (await req.json().catch(() => ({}))) as {
    id?: number;
    result?: RelayResult;
    instance?: string;
  };
  const inst = (instance ?? env.INSTANCE ?? "").toLowerCase();
  // Authenticate as the spoke, and scope the write to rows addressed to that spoke, so a
  // secret-holder can't answer (and thereby suppress) another instance's queued queries.
  if (!(await spokeAuth(req, env, inst))) return new Response("unauthorized", { status: 401 });
  if (!id || !result) return json({ error: "id and result required" }, { status: 400 });
  await env.DB.prepare(
    "UPDATE fed_relay_queue SET status='answered', answer=?, answered_at=? WHERE id=? AND status='leased' AND instance=?",
  )
    .bind(JSON.stringify(result), now(), id, inst)
    .run();
  return json({ ok: true });
}

/** GET /federation/relay/result/:id — the requester polls for the spoke's answer. */
export async function handleRelayResult(req: Request, env: Env, id: string): Promise<Response> {
  if (!relayAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const row = await env.DB.prepare("SELECT status, answer FROM fed_relay_queue WHERE id = ?")
    .bind(Number(id))
    .first<{ status: string; answer: string | null }>();
  if (!row) return json({ error: "no such query" }, { status: 404 });
  return json({ status: row.status, answer: row.answer ? JSON.parse(row.answer) : null });
}

// ------------------------------------------------------------------ packet-carried leg
/**
 * POST /federation/relay/:instance/dispatch — the hub packs a packet-only spoke's queued relay
 * queries into an `ACSFED` bulletin of signed `relayQuery` frames and marks them leased; the FBB
 * mesh carries the bulletin out, and the spoke's answers come back the same way as signed
 * `relayAnswer` frames (the store-and-forward receive lands them in this queue). The frame
 * signatures bind both directions to their instances — the per-spoke HMAC token exists only on the
 * HTTP legs, so no secret material ever rides the air.
 */
export async function handleRelayDispatch(req: Request, env: Env, instance: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowIngest: true });
  if (denied) return denied;
  const spoke = instance.toLowerCase();
  const hub = (env.INSTANCE ?? "").toLowerCase();
  if (!hub) return json({ error: "INSTANCE required" }, { status: 500 });
  const rows = (
    await env.DB.prepare(
      "SELECT id, kind, params FROM fed_relay_queue WHERE instance = ? AND status = 'queued' ORDER BY created_at LIMIT 25",
    )
      .bind(spoke)
      .all<{ id: number; kind: string; params: string }>()
  ).results;
  if (!rows.length) return json({ ok: true, dispatched: 0 });

  const at = now();
  const frames: Uint8Array[] = [];
  for (const r of rows) {
    const frame = await signFedRecord(env, {
      kind: "relayQuery",
      gid: `${hub}:relay:${r.id}`,
      origin: hub,
      v: at,
      at,
      signer: hub,
      body: { id: r.id, target: spoke, kind: r.kind, paramsJson: r.params },
    });
    if (!frame) return json({ error: "instance is unsigned — configure FED_PRIVATE_KEY" }, { status: 409 });
    frames.push(frame);
  }
  const bull = await enqueueAcsfedBulletin(env, frames);
  const t = now();
  await env.DB.batch(
    rows.map((r) => env.DB.prepare("UPDATE fed_relay_queue SET status='leased', leased_at=? WHERE id=?").bind(t, r.id)),
  );
  return json({ ok: true, dispatched: rows.length, bid: bull.bid, enqueued: bull.enqueued });
}

// ------------------------------------------------------------------ spoke-side poller
/**
 * A NAT'd spoke leases relay queries from its hub and answers them from its own DB. Run from `runScheduled`;
 * a no-op unless both `FED_HUB_URL` and `FED_RELAY_SECRET` are set. This is the outbound-only leg that makes
 * a firewalled peer's feed reachable through the hub.
 */
export async function relayPoll(env: Env): Promise<void> {
  const hub = env.FED_HUB_URL,
    secret = env.FED_RELAY_SECRET;
  if (!hub || !secret) return;
  const instance = (env.INSTANCE ?? "").toLowerCase();
  // Present a per-spoke token bound to our own instance (alongside the shared secret for
  // backward compat) so the hub scopes what we can lease/answer to our own queue.
  const token = (await relaySpokeToken(env, instance)) ?? "";
  const h = { "content-type": "application/json", "x-relay-secret": secret, "x-relay-token": token };
  const leaseRes = await fetch(`${hub}/federation/relay/lease?instance=${encodeURIComponent(instance)}`, {
    headers: h,
  });
  if (!leaseRes.ok) return;
  const { queries } = (await leaseRes.json().catch(() => ({ queries: [] }))) as {
    queries: { id: number; kind: RelayKind; params: Record<string, unknown> }[];
  };
  for (const q of queries ?? []) {
    const result = await answerRelayQuery(
      { kind: q.kind, params: q.params ?? {} },
      { feed: (p) => feedSource(env, p) },
    );
    await fetch(`${hub}/federation/relay/answer`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ id: q.id, result, instance }),
    }).catch(() => {});
  }
}
