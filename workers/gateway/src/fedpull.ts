// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedpull.ts — the consumer side of federation. Pull peers' CBOR sync feeds, verify each frame under
 * the key set pinned for the peer (checked against its descriptor, the signed registry and its
 * rotation records), and hand every frame to the shared admission path (fedapply.ts). Per-peer
 * cursors make it incremental; one pull per peer runs at a time.
 *
 * Runtime-neutral (fetch + crypto.subtle + env.DB) → runs on Cloudflare, Node and Bun alike. This
 * instance never mirrors itself.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { nowS } from "./util/time.js";
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import {
  FED_PROTOCOL_VERSION,
  type FedPublicKey,
  isInstanceId,
  loadRegistry,
  parseAcceptKeys,
  registryKeyAllowed,
  resolvePeerKeys,
  usableKeys,
  type RotationRecord,
} from "./federation.js";
import { syncTransportFor, type FedSyncTransport } from "./fedtransport.js";
import { decodeFedSyncPage } from "./fedsync.js";
import { validEndpointAddress } from "@aprscaching/shared";
import { type PeerRow, ours, seedPeers, listEnabledPeers } from "./fedpeers.js";
import { SYNC_DEFS, type SyncDef, type FrameGate, admitFrame } from "./fedapply.js";
import { bboxKey, parseBbox, SYNC_REGION_CAPABILITY } from "./fedregion.js";

/** Most pages one pass reads (pull) or sends (push) per feed. */
export const MAX_PAGES = 50;

/** Largest pull page the consumer reads, and the most frames it accepts per requested page. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_LIMIT = 500;
/** Discovered peers, across all sources: the table never grows past this through discovery. */
const MAX_DISCOVERED = 200;

/**
 * A narrower pull, for an operator who pays for every byte (a phone before a trip): only some feeds,
 * at most some pages of each. It limits how far one pass reads, never what later passes see: a skipped
 * feed keeps its cursor, and a capped feed carries on from where it stopped.
 */
interface PullOptions {
  /** Feed types to pull. Deletes (tombstones) always come too, so a narrowed pull never misses one. */
  types?: string[];
  /** Pages per feed, 1 to MAX_PAGES. */
  maxPages?: number;
}

/**
 * Sync a single peer by its instance id — the gossip-ping target. Only an enabled, non-blocked
 * peer we already follow is synced; the pull is signature-verified as usual. Returns whether it ran.
 */
export async function syncPeerByInstance(env: Env, instance: string): Promise<boolean> {
  await seedPeers(env);
  const p = await env.DB.prepare(
    "SELECT * FROM fed_peers WHERE instance = ? AND enabled = 1 AND trust != 'blocked' LIMIT 1",
  )
    .bind(instance)
    .first<PeerRow>();
  if (!p) return false;
  return syncOnePeer(env, p);
}

type PeerSyncCounts = Awaited<ReturnType<typeof syncPeer>>;
/**
 * One pull per peer at a time, whoever asks — the scheduled sync, a notify, or both at once: a caller
 * arriving mid-pull gets a fresh pull after it (trailing-edge coalescing), never a concurrent one, so
 * the version checks and cursor writes of two pulls can't interleave.
 */
function syncPeerCoalesced(env: Env, p: PeerRow, opts: PullOptions = {}): Promise<PeerSyncCounts> {
  return coalesceRun(peerKey(env, p.url), () => syncPeer(env, p, opts), peerCoalescer);
}

async function syncOnePeer(env: Env, p: PeerRow): Promise<boolean> {
  try {
    await syncPeerCoalesced(env, p);
    return true;
  } catch (e) {
    await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=?, sync_err = sync_err + 1 WHERE url=?")
      .bind((e as Error).message, nowS(), p.url)
      .run();
    return false;
  }
}

// Node/Bun drive a periodic federation-sync interval AND the nightly `runScheduled` (which
// also calls this) — near boot they can overlap and double-pull every peer. Coalesce per-env so a
// burst collapses instead of starting N concurrent pulls.
//
// A caller must NOT simply join the run already in flight: that run took its snapshot of every peer
// before the caller asked, so it cannot contain anything written since. An explicit
// /federation/sync right after a federated write would then report 0 mirrored — the record only
// lands on the *next* pull. So a caller arriving mid-run waits for it and gets a fresh run instead;
// everyone who arrives during the same run shares that one follow-up, bounding a burst at one extra
// pull. Sequential (awaited) calls are unaffected.
type SyncResult = {
  peers: number;
  /** Bytes of sync pages read, across every peer and feed. */
  bytes: number;
  caches: number;
  finds: number;
  keys: number;
  tombstones: number;
  moves: number;
  bulletins: number;
  errors: string[];
};

/** Per-key coalescing state: the pull in flight, plus the single follow-up owed to mid-run callers. */
export type Coalescer<T> = { inFlight: WeakMap<object, Promise<T>>; queued: WeakMap<object, Promise<T>> };
export const newCoalescer = <T>(): Coalescer<T> => ({ inFlight: new WeakMap(), queued: new WeakMap() });

/** Trailing-edge coalescing: never hand back a run that started before the caller asked. Pure + exported for test. */
export function coalesceRun<T>(key: object, run: () => Promise<T>, state: Coalescer<T>): Promise<T> {
  const start = (): Promise<T> => {
    const p: Promise<T> = run().finally(() => {
      if (state.inFlight.get(key) === p) state.inFlight.delete(key);
    });
    state.inFlight.set(key, p);
    return p;
  };
  const running = state.inFlight.get(key);
  if (!running) return start();
  const queued = state.queued.get(key);
  if (queued) return queued; // a follow-up is already promised to this wave of callers
  const next = running
    .catch(() => {}) // a failed run must not poison the callers waiting behind it
    .then(() => {
      state.queued.delete(key);
      return start();
    });
  state.queued.set(key, next);
  return next;
}

const syncCoalescer = newCoalescer<SyncResult>();

const peerCoalescer = newCoalescer<PeerSyncCounts>();
const peerKeys = new WeakMap<object, Map<string, object>>();
/** A stable coalescing key per (env, peer url). */
function peerKey(env: Env, url: string): object {
  let m = peerKeys.get(env);
  if (!m) peerKeys.set(env, (m = new Map()));
  let k = m.get(url);
  if (!k) m.set(url, (k = {}));
  return k;
}

/**
 * Pull every enabled peer. A narrowed pull (`opts`) coalesces with a full one like any other caller:
 * whichever pass runs, the cursors stay exact, so the next pass reads what this one left.
 */
export async function syncAllPeers(env: Env, opts: PullOptions = {}): Promise<SyncResult> {
  return coalesceRun(env, () => syncAllPeersInner(env, opts), syncCoalescer);
}

async function syncAllPeersInner(env: Env, opts: PullOptions): Promise<SyncResult> {
  const peers = await listEnabledPeers(env);
  let bytes = 0,
    caches = 0,
    finds = 0,
    keys = 0,
    tombstones = 0,
    moves = 0,
    bulletins = 0;
  const errors: string[] = [];
  for (const p of peers) {
    try {
      const r = await syncPeerCoalesced(env, p, opts);
      bytes += r.bytes;
      caches += r.caches;
      finds += r.finds;
      keys += r.keys;
      tombstones += r.tombstones;
      moves += r.moves;
      bulletins += r.bulletins;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${p.url}: ${msg}`);
      await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=?, sync_err = sync_err + 1 WHERE url=?")
        .bind(msg, nowS(), p.url)
        .run();
    }
  }
  return { peers: peers.length, bytes, caches, finds, keys, tombstones, moves, bulletins, errors };
}

async function syncPeer(
  env: Env,
  p: PeerRow,
  opts: PullOptions = {},
): Promise<{
  bytes: number;
  caches: number;
  finds: number;
  keys: number;
  tombstones: number;
  moves: number;
  bulletins: number;
}> {
  // endpoint selection: the peer's typed endpoint set picks the sync transport (https, or plain
  // http on a 44net/HAMNET name); packet endpoints are forward-mode and never pulled from here
  const transport = syncTransportFor(p, (u, i) => fedFetch(env, u, i));
  if (!transport) throw new Error("peer has no sync-capable endpoint");
  const base = transport.baseUrl;
  const wk = await transport.fetchJson<{
    instance: string;
    signed: boolean;
    publicKey: string | null;
    publicKeys?: FedPublicKey[];
    rotations?: RotationRecord[];
    peers?: string[];
    capabilities?: string[];
    protocolVersions?: string[];
  }>("/.well-known/aprscaching");
  const pub = wk.signed ? wk.publicKey : null;

  // Identity first, and nothing is written until every check below has passed. The instance id
  // must be a plain hostname (a `:` would let it claim a slice of another namespace), and once a
  // row is bound to an instance the binding never moves: a descriptor naming another instance is a
  // different server answering on this URL.
  if (!isInstanceId(wk.instance)) throw new Error(`descriptor names an invalid instance id — refusing`);
  if (p.instance && p.instance !== wk.instance)
    throw new Error(`descriptor names instance ${wk.instance} but this peer is bound to ${p.instance} — refusing`);
  // never mirror ourselves
  if (wk.instance === ours(env))
    return { bytes: 0, caches: 0, finds: 0, keys: 0, tombstones: 0, moves: 0, bulletins: 0 };
  // one live row per instance id: a second URL claiming a bound instance is an impostor or a stale
  // address, and the operator decides which (block or delete the other row)
  const holder = await env.DB.prepare(
    "SELECT url FROM fed_peers WHERE instance = ? AND url != ? AND trust != 'blocked'",
  )
    .bind(wk.instance, p.url)
    .first<{ url: string }>();
  if (holder) throw new Error(`instance ${wk.instance} is already bound to ${holder.url} — refusing`);

  // anti-spoof: if a signed registry binds this instance to a key, the peer's CURRENT key must be
  // that key. Unregistered peers fall back to trust-on-first-use.
  const registryEntry = (await loadRegistry(env)).get(wk.instance);
  if (!registryKeyAllowed(registryEntry, pub))
    throw new Error(`registry key mismatch for ${wk.instance} — refusing to mirror (possible spoof)`);

  // never blindly re-pin: the pin moves only along a verified rotation chain, other published keys
  // count only as proven predecessors inside their grace, and a rotated-away key stays revoked
  const keys = await resolvePeerKeys({
    pinned: p.public_key,
    current: pub,
    published: Array.isArray(wk.publicKeys) ? wk.publicKeys : [],
    rotations: wk.rotations,
    prior: parseAcceptKeys(p.accept_keys),
    nowS: nowS(),
    graceDays: env.FED_ROTATION_GRACE_DAYS ? Number(env.FED_ROTATION_GRACE_DAYS) : undefined,
  });
  if (!keys.ok) throw new Error(`peer ${wk.instance}: ${keys.reason} — refusing (possible hijack)`);
  const acceptJson = JSON.stringify(keys.accept);
  try {
    await env.DB.prepare("UPDATE fed_peers SET instance=?, public_key=?, accept_keys=? WHERE url=?")
      .bind(wk.instance, keys.pin, acceptJson, p.url)
      .run();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message))
      throw new Error(`instance ${wk.instance} is already bound to another peer — refusing`, { cause: e });
    throw e;
  }
  const newActive = usableKeys(keys.accept, nowS());

  // Opt-in transitive discovery: learn the peers a TRUSTED peer advertises. Only https URLs are
  // taken, a learned peer starts `unvetted` and disabled (never fetched until an operator enables
  // it), and discovery stops adding once MAX_DISCOVERED discovered rows exist. INSERT OR IGNORE never
  // downgrades a peer already known.
  if (env.FED_DISCOVER && p.trust === "trusted") {
    const have =
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM fed_peers WHERE added_via = 'discovered'").first<{
          n: number;
        }>()
      )?.n ?? 0;
    let room = Math.max(0, MAX_DISCOVERED - have);
    for (const url of (Array.isArray(wk.peers) ? wk.peers : []).slice(0, 50)) {
      if (room <= 0) break;
      const u = trimTrailingSlashes(String(url).trim());
      if (!u || u === base || !validEndpointAddress("https", u)) continue;
      const r = await env.DB.prepare(
        "INSERT OR IGNORE INTO fed_peers (url, trust, added_via, enabled) VALUES (?, 'unvetted', 'discovered', 0)",
      )
        .bind(u)
        .run();
      if (r.meta.changes) room--;
    }
  }

  // capability negotiation: a peer that speaks our protocol version has an authoritative
  // capability list → skip feeds it doesn't advertise; otherwise every known feed is tried and a 404
  // is treated as "not supported" (syncFeed below). SYNC_DEFS is ordered tombstones-FIRST so a
  // delete suppresses re-mirroring of a stale record later in the same pass. The CBOR sync surface
  // is the only mirror wire — a peer without it (or unsigned) simply has nothing verifiable to
  // mirror, and its feeds are skipped via the same 404 contract.
  const toSync = new Set(negotiateFeeds(wk, SYNC_DEFS, FED_PROTOCOL_VERSION).map((d) => d.type));
  const wanted = opts.types ? new Set([...opts.types, "tombstone"]) : null;
  // The caches feed narrows to FED_SYNC_REGION where the publisher filters by region; elsewhere it
  // travels whole.
  const region = parseBbox(env.FED_SYNC_REGION);
  if (env.FED_SYNC_REGION && !region)
    console.warn("federation: FED_SYNC_REGION is not S,W,N,E in decimal degrees; pulling every cache");
  const feedOpts: FeedPullOptions = {
    maxPages: Math.min(Math.max(1, opts.maxPages ?? MAX_PAGES), MAX_PAGES),
    region: region && (wk.capabilities ?? []).includes(SYNC_REGION_CAPABILITY) ? bboxKey(region) : "",
    bytes: 0,
  };
  const counts: Record<string, number> = {};
  for (const def of SYNC_DEFS) {
    // iterate SYNC_DEFS to preserve the tombstones-first order
    if (!toSync.has(def.type) || (wanted && !wanted.has(def.type))) {
      counts[def.type] = 0;
      continue;
    }
    counts[def.type] = await syncFeed(env, transport, p, wk.instance, newActive, def, feedOpts);
  }
  // observability: record a successful sync — time, count, cumulative total, per-feed breakdown
  // (surfaced via /federation/peers → last_counts)
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await env.DB.prepare(
    `UPDATE fed_peers SET last_sync=?, last_ok=?, last_error=NULL, sync_ok = sync_ok + 1,
       mirrored_total = mirrored_total + ?, last_counts = ? WHERE url=?`,
  )
    .bind(nowS(), nowS(), total, JSON.stringify({ ...counts, encoding: "cbor" }), p.url)
    .run();
  return {
    bytes: feedOpts.bytes,
    caches: counts.cache ?? 0,
    finds: counts.find ?? 0,
    keys: counts.key ?? 0,
    tombstones: counts.tombstone ?? 0,
    moves: counts["account-move"] ?? 0,
    bulletins: counts.bulletin ?? 0,
  };
}

/**
 * Capability negotiation (pure/testable): which of our feed defs to pull from a peer. A peer that
 * advertises our protocol version has an authoritative capability list → pull only the feeds it offers;
 * a peer that does not advertise our protocol version is tried for every known feed (a 404 is handled gracefully
 * by syncFeed). Order is preserved, so the tombstones-first invariant survives.
 */
export function negotiateFeeds<T extends { capability: string }>(
  wk: { capabilities?: string[]; protocolVersions?: string[] },
  defs: T[],
  ourVersion: string,
): T[] {
  const negotiated = Array.isArray(wk.protocolVersions) && wk.protocolVersions.includes(ourVersion);
  if (!negotiated) return defs;
  const caps = new Set(wk.capabilities ?? []);
  return defs.filter((d) => caps.has(d.capability));
}

/**
 * Generalized feed consumer: pull CBOR sync pages, verify each fedwire frame over its bytes
 * verbatim under the peer's active keys, run the acceptance checks, apply, advance the peer cursor
 * — one loop for every record type. A 404 means the peer doesn't serve this feed → skip it
 * gracefully, never failing the whole sync. The origin is ALWAYS the verified serving peer
 * (wk.instance), never anything the payload claims — a peer inherits only its own namespace + trust.
 */
/** How one feed is pulled: the page cap, the caches region ('' = whole), and the bytes read so far. */
interface FeedPullOptions {
  maxPages: number;
  region: string;
  bytes: number;
}

async function syncFeed(
  env: Env,
  transport: FedSyncTransport,
  p: PeerRow,
  instance: string,
  activeKeys: string[],
  def: SyncDef,
  opts: FeedPullOptions,
): Promise<number> {
  let cursor = (p[def.cursorCol] as number) ?? 0,
    cursorId = def.cursorIdCol ? (p[def.cursorIdCol] ?? null) : null,
    applied = 0;
  // A cursor is exact only for the region it was read under: a new region (or none) reads the caches
  // feed again from the start. Deletes are never filtered, so nothing stale survives a region change.
  const region = def.type === "cache" ? opts.region : "";
  if (def.type === "cache" && (p.caches_region ?? "") !== region) {
    cursor = 0;
    cursorId = null;
    await env.DB.prepare("UPDATE fed_peers SET caches_cursor=0, caches_cursor_id=NULL, caches_region=? WHERE url=?")
      .bind(region, p.url)
      .run();
    p.caches_region = region;
  }
  const regionParam = region ? `&bbox=${region}` : "";
  // the origin is the verified serving peer, its frames verify under its active keys, and a page
  // carries only its own feed's type
  const gate: FrameGate = { origin: instance, type: def.type, keysFor: () => Promise.resolve(activeKeys) };
  for (let page = 0; page < opts.maxPages; page++) {
    const idParam = cursorId != null ? `&sinceId=${cursorId}` : "";
    const res = await transport.get(
      `/federation/sync/${def.type}?since=${cursor}${idParam}${regionParam}&limit=${PAGE_LIMIT}`,
    );
    if (res.status === 404) return applied; // feed not served here → forward-compat skip
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- /federation/sync/${def.type}`);
    const body = await readCappedBody(res, MAX_PAGE_BYTES);
    if (!body) throw new Error(`/federation/sync/${def.type} page too large (over ${MAX_PAGE_BYTES} bytes)`);
    opts.bytes += body.byteLength;
    const pg = decodeFedSyncPage(body);
    if (pg.frames.length > PAGE_LIMIT)
      throw new Error(`/federation/sync/${def.type} page has ${pg.frames.length} frames (asked for ${PAGE_LIMIT})`);
    for (const fb of pg.frames) {
      // each frame stands alone: a malformed or unappliable record is skipped, never a reason to
      // hold the cursor and replay the page forever
      const skipped = (e: unknown) =>
        console.warn(`federation: skipped a ${def.type} record from ${instance}: ${(e as Error).message}`);
      try {
        const { verdict, error } = await admitFrame(env, fb, gate);
        if (verdict === "applied") applied++;
        else if (error) skipped(error);
      } catch (e) {
        skipped(e);
      }
    }
    const next = pg.nextCursor ?? cursor;
    // The id tie-breaker only carries a pass across full pages that share one timestamp. Once a page
    // is complete it is dropped, so the next pull re-reads the boundary second (idempotent) and still
    // sees a record updated again within that second.
    const nextId = def.cursorIdCol && !pg.complete && pg.nextId !== undefined ? pg.nextId : null;
    if (def.cursorIdCol)
      await env.DB.prepare(`UPDATE fed_peers SET ${def.cursorCol}=?, ${def.cursorIdCol}=? WHERE url=?`)
        .bind(next, nextId, p.url)
        .run();
    else await env.DB.prepare(`UPDATE fed_peers SET ${def.cursorCol}=? WHERE url=?`).bind(next, p.url).run();
    if (pg.complete || (next === cursor && (nextId == null || nextId === cursorId))) break;
    cursor = next;
    cursorId = nextId;
  }
  return applied;
}

// ---- endpoints ----
/**
 * POST /federation/sync — run a pull from every peer now (the scheduled sync runs the same). Operator-only.
 * An optional JSON body narrows it: `{ types?: feed types, maxPages?: 1–MAX_PAGES }` (PullOptions).
 */
export async function handleFederationSync(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const raw = await req.text();
  let body: { types?: unknown; maxPages?: unknown } = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json({ error: "the body must be JSON" }, { status: 400 });
    }
  }
  const known = new Set(SYNC_DEFS.map((d) => d.type));
  const opts: PullOptions = {};
  if (body.types !== undefined) {
    if (!Array.isArray(body.types) || !body.types.every((t) => typeof t === "string" && known.has(t)))
      return json({ error: `types must be a list of: ${[...known].join(", ")}` }, { status: 400 });
    opts.types = body.types as string[];
  }
  if (body.maxPages !== undefined) {
    const n = Number(body.maxPages);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES)
      return json({ error: `maxPages must be 1–${MAX_PAGES}` }, { status: 400 });
    opts.maxPages = n;
  }
  const summary = await syncAllPeers(env, opts);
  return json({ ok: true, ...summary });
}
