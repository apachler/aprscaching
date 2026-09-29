// SPDX-License-Identifier: AGPL-3.0-or-later
import { b64urlToBytes, bytesToB64, bytesToB64url } from "./util/b64.js";
import { nowS } from "./util/time.js";
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
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
 * relay is pure transport. The spoke answers `feed` queries (downstream re-serving of a firewalled
 * peer's feed); `corroborate` is a reserved kind. The relay is enabled by `FED_RELAY_SECRET`, which
 * gates enqueueing and reading results; a requester reads only its own results, by the ticket it got
 * at enqueue time. A spoke leases and answers by signing each request with its own federation key,
 * which the hub checks against the key it already holds for that instance — a spoke can never act
 * for another spoke, whatever secrets it knows. A lease that goes unanswered returns to the queue.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { signFedRecord } from "./fedcbor.js";
import { enqueueAcsfedBulletin } from "./fedforward.js";
import { buildFedFrames, encodeFedSyncPage } from "./fedsync.js";
import { importVerifyKey, signRaw } from "./federation.js";
import { keysForOrigin } from "./fedpeers.js";
import { clientIp, rateLimitedDurable } from "./corroborate_privacy.js";

type RelayKind = "feed" | "corroborate";
interface ParsedRelayQuery {
  kind: RelayKind;
  params: Record<string, unknown>;
}
interface RelayResult {
  ok: boolean;
  kind: RelayKind;
  data?: unknown;
  error?: string;
}

const relayAuth = (req: Request, env: Env): boolean => {
  const s = env.FED_RELAY_SECRET;
  return secretOk(req.headers.get("x-relay-secret"), s);
};

/** A lease not answered within this many seconds returns to the queue. */
const RELAY_LEASE_TTL_S = 300;
/** How far a spoke's signed request time may sit from the hub's clock. */
const RELAY_SKEW_S = 120;
/** Queries one requester may have waiting at once, and enqueues it may make per minute. */
const RELAY_MAX_QUEUED_PER_REQUESTER = 50;
const RELAY_ENQUEUE_PER_MINUTE = 60;
const RELAY_DOMAIN = "acs-relay/1\n";

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes));

/** The bytes a spoke signs for one relay request: method, path with query, time and body hash. */
async function relaySigningBytes(
  method: string,
  pathAndQuery: string,
  at: number,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const text = `${RELAY_DOMAIN}${method.toUpperCase()} ${pathAndQuery}\n${at}\n${await sha256Hex(body)}`;
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/** Headers that authenticate a relay request as this instance (its federation key signs it). */
async function signRelayRequest(
  env: Env,
  method: string,
  url: string,
  body: string = "",
): Promise<Record<string, string> | null> {
  const instance = (env.INSTANCE ?? "").toLowerCase();
  const at = nowS();
  const u = new URL(url);
  const signed = await signRaw(
    env,
    await relaySigningBytes(
      method,
      u.pathname + u.search,
      at,
      new TextEncoder().encode(body) as Uint8Array<ArrayBuffer>,
    ),
  );
  if (!instance || !signed) return null;
  return {
    "x-relay-instance": instance,
    "x-relay-at": String(at),
    "x-relay-sig": bytesToB64url(signed.sig),
  };
}

/**
 * Is this request signed by `instance`'s federation key? The hub must already hold that key (the
 * spoke is a known peer: pulled, in the registry, or registered by a push-to-hub submission).
 */
async function spokeAuth(req: Request, env: Env, instance: string, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (!instance || req.headers.get("x-relay-instance")?.toLowerCase() !== instance) return false;
  const at = Number(req.headers.get("x-relay-at"));
  const sig = req.headers.get("x-relay-sig") ?? "";
  if (!Number.isInteger(at) || Math.abs(at - nowS()) > RELAY_SKEW_S || !sig) return false;
  const keys = await keysForOrigin(env, instance);
  if (keys === "blocked" || !keys.length) return false;
  const u = new URL(req.url);
  const msg = await relaySigningBytes(req.method, u.pathname + u.search, at, body);
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = b64urlToBytes(sig);
  } catch {
    return false;
  }
  for (const k of keys) {
    try {
      if (await crypto.subtle.verify("Ed25519", await importVerifyKey(k), sigBytes, msg)) return true;
    } catch {
      /* an unusable key simply doesn't verify */
    }
  }
  return false;
}

/** Largest answer a spoke may post: a full relayed feed page, base64, with room to spare. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/**
 * Nightly housekeeping of the relay queue: an HTTP query older than an hour is stale, but a query
 * dispatched over the FBB mesh may take days to come back, so it is kept for a week.
 */
export async function purgeRelayQueue(env: Env): Promise<void> {
  const t = nowS();
  await env.DB.prepare(
    "DELETE FROM fed_relay_queue WHERE (status != 'dispatched' AND created_at < ?) OR created_at < ?",
  )
    .bind(t - 3600, t - 7 * 86400)
    .run();
}

/** Return leases older than the TTL to the queue, so a spoke that vanished mid-lease loses nothing. */
export async function expireRelayLeases(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE fed_relay_queue SET status = 'queued', leased_at = NULL WHERE status = 'leased' AND leased_at < ?",
  )
    .bind(nowS() - RELAY_LEASE_TTL_S)
    .run();
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

/**
 * The spoke's real feed source: answer with a base64 fedwire sync page — the same signed frames as
 * every other carrier; the requester's gateway verifies each frame when it consumes the page.
 */
export async function feedSource(env: Env, params: Record<string, unknown>): Promise<unknown> {
  const name = typeof params.feed === "string" ? params.feed : "caches";
  const type = SYNC_TYPE_BY_FEED[name];
  if (!type) throw new Error(`unknown feed '${name}'`);
  const since = Math.max(0, Number(params.since ?? 0) || 0);
  const limit = Math.min(Math.max(Number(params.limit ?? 200) || 200, 1), 1000);
  const instance = env.INSTANCE ?? "local";
  const built = await buildFedFrames(env, instance, type, since, limit);
  if (!built) throw new Error("instance is unsigned — no verifiable frames to serve");
  return {
    feed: name,
    since,
    encoding: "cbor",
    nextCursor: built.nextCursor,
    complete: built.frames.length < limit,
    pageB64: bytesToB64(encodeFedSyncPage(instance, built.nextCursor, built.frames.length < limit, built.frames)),
  };
}

// ------------------------------------------------------------------ hub-side endpoints
/** POST /federation/relay/:instance/query — a requester enqueues a relay query for a spoke instance. */
export async function handleRelayEnqueue(req: Request, env: Env, instance: string): Promise<Response> {
  if (!relayAuth(req, env)) return json({ error: "relay disabled or bad secret" }, { status: 401 });
  const requester = clientIp(req, env);
  if (await rateLimitedDurable(env, `relay-enqueue:${requester}`, Date.now(), RELAY_ENQUEUE_PER_MINUTE))
    return json({ error: "rate limited" }, { status: 429 });
  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM fed_relay_queue WHERE requester = ? AND status IN ('queued','leased','dispatched')",
  )
    .bind(requester)
    .first<{ n: number }>();
  if ((waiting?.n ?? 0) >= RELAY_MAX_QUEUED_PER_REQUESTER)
    return json({ error: "too many queries waiting" }, { status: 429 });
  const q = parseRelayQuery(await req.json().catch(() => null));
  if (!q) return json({ error: "kind (feed|corroborate) required" }, { status: 400 });
  const ticket = hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  const ins = await env.DB.prepare(
    "INSERT INTO fed_relay_queue (instance, kind, params, status, created_at, ticket_hash, requester) VALUES (?,?,?, 'queued', ?, ?, ?)",
  )
    .bind(
      instance.toLowerCase(),
      q.kind,
      JSON.stringify(q.params),
      nowS(),
      await sha256Hex(new TextEncoder().encode(ticket) as Uint8Array<ArrayBuffer>),
      requester,
    )
    .run();
  return json({ id: Number(ins.meta.last_row_id), ticket, instance, kind: q.kind, status: "queued" }, { status: 201 });
}

/** GET /federation/relay/lease?instance=SELF — the spoke leases queries addressed to it. */
export async function handleRelayLease(req: Request, env: Env): Promise<Response> {
  const instance = (new URL(req.url).searchParams.get("instance") ?? "").toLowerCase();
  if (!instance) return json({ error: "instance required" }, { status: 400 });
  // A spoke leases only its own queue: the request must be signed by that instance's key.
  if (!(await spokeAuth(req, env, instance, new Uint8Array(0)))) return new Response("unauthorized", { status: 401 });
  await expireRelayLeases(env);
  const rows = (
    await env.DB.prepare(
      "SELECT id, kind, params FROM fed_relay_queue WHERE instance = ? AND status = 'queued' ORDER BY created_at LIMIT 25",
    )
      .bind(instance)
      .all<{ id: number; kind: string; params: string }>()
  ).results;
  if (rows.length) {
    const t = nowS();
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
  const raw = await readCappedBody(req, MAX_ANSWER_BYTES);
  if (!raw) return json({ error: "answer too large" }, { status: 413 });
  let parsed: { id?: number; result?: RelayResult; instance?: string } = {};
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as typeof parsed;
  } catch {
    /* validated below */
  }
  const { id, result, instance } = parsed;
  const inst = (instance ?? "").toLowerCase();
  // Authenticate as the spoke by its key, and scope the write to rows addressed to that spoke, so
  // no one can answer (and thereby suppress) another instance's queued queries.
  if (!(await spokeAuth(req, env, inst, raw))) return new Response("unauthorized", { status: 401 });
  if (!id || !result) return json({ error: "id and result required" }, { status: 400 });
  await env.DB.prepare(
    "UPDATE fed_relay_queue SET status='answered', answer=?, answered_at=? WHERE id=? AND status='leased' AND instance=?",
  )
    .bind(JSON.stringify(result), nowS(), id, inst)
    .run();
  return json({ ok: true });
}

/** GET /federation/relay/result/:id — the requester polls for the spoke's answer. */
export async function handleRelayResult(req: Request, env: Env, id: string): Promise<Response> {
  if (!relayAuth(req, env)) return new Response("unauthorized", { status: 401 });
  const row = await env.DB.prepare("SELECT status, answer, ticket_hash FROM fed_relay_queue WHERE id = ?")
    .bind(Number(id))
    .first<{ status: string; answer: string | null; ticket_hash: string | null }>();
  if (!row) return json({ error: "no such query" }, { status: 404 });
  // only the requester, holding the ticket it was given, reads the result
  const ticket = req.headers.get("x-relay-ticket") ?? "";
  const presented = await sha256Hex(new TextEncoder().encode(ticket) as Uint8Array<ArrayBuffer>);
  if (!ticket || !row.ticket_hash || !secretOk(presented, row.ticket_hash))
    return json({ error: "not your query" }, { status: 403 });
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
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
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

  const at = nowS();
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
  const t = nowS();
  await env.DB.batch(
    // dispatched, not leased: an FBB round trip takes hours, so these never time back into the queue
    rows.map((r) =>
      env.DB.prepare("UPDATE fed_relay_queue SET status='dispatched', leased_at=? WHERE id=?").bind(t, r.id),
    ),
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
  const hub = env.FED_HUB_URL ? trimTrailingSlashes(env.FED_HUB_URL) : undefined;
  if (!hub || !env.FED_RELAY_SECRET) return;
  const instance = (env.INSTANCE ?? "").toLowerCase();
  // every lease and answer is signed with our federation key; the hub scopes both to our own queue
  const leaseUrl = `${hub}/federation/relay/lease?instance=${encodeURIComponent(instance)}`;
  const leaseAuth = await signRelayRequest(env, "GET", leaseUrl);
  if (!leaseAuth) return; // no signing key — the hub could not tell us from anyone else
  const leaseRes = await fedFetch(env, leaseUrl, { headers: leaseAuth });
  if (!leaseRes.ok) return;
  const { queries } = (await leaseRes.json().catch(() => ({ queries: [] }))) as {
    queries: { id: number; kind: RelayKind; params: Record<string, unknown> }[];
  };
  for (const q of queries ?? []) {
    const result = await answerRelayQuery(
      { kind: q.kind, params: q.params ?? {} },
      { feed: (p) => feedSource(env, p) },
    );
    const answerUrl = `${hub}/federation/relay/answer`;
    const body = JSON.stringify({ id: q.id, result, instance });
    const auth = await signRelayRequest(env, "POST", answerUrl, body);
    if (!auth) return;
    await fedFetch(env, answerUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body,
    }).catch(() => {});
  }
}
