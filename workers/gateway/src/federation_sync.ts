// SPDX-License-Identifier: AGPL-3.0-or-later
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import { secretOk } from "./auth.js";
/**
 * federation_sync.ts — the consumer side. Pull peers' /federation feeds, verify each record's
 * Ed25519 signature against the public key they publish at /.well-known/aprscaching, and mirror
 * the records locally (remote_caches / remote_finds). Per-peer cursors make it incremental.
 *
 * Runtime-neutral (fetch + crypto.subtle + env.DB) → runs on Cloudflare and Node alike.
 * Mirrored rows are display-only: we never re-publish them and never mirror our own instance.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import {
  FED_PROTOCOL_VERSION,
  type FedPublicKey,
  isInstanceId,
  loadRegistry,
  parseAcceptKeys,
  registryKeyAllowed,
  resolvePeerKeys,
  usableKeys,
  CACHE_FEED,
  FIND_FEED,
  KEY_FEED,
  type FeedServeDef,
  verifyRotationRecord,
  type RotationRecord,
  type RegistryEntry,
  importVerifyKey,
  fromB64,
} from "./federation.js";
import { TOMBSTONE_FEED } from "./tombstones.js";
import { upsertRemoteBulletin } from "./bbs.js";
import { syncTransportFor, type FedSyncTransport } from "./fedtransport.js";
import { verifyFedFrame, signFedRecord } from "./fedcbor.js";
import { decodeFedSyncPage, encodeFedSyncPage, buildFedFrames, bodyFromWire } from "./fedsync.js";
import { answerRelayQuery, feedSource, parseRelayQuery } from "./relay.js";
import { enqueueAcsfedBulletin } from "./fedforward.js";
import {
  accountActionMessage,
  validEndpointAddress,
  decodeFedFrame,
  decodeFedBbsBatch,
  parseEndpoints,
  type FedRecord,
  type FedRecordKind,
} from "@aprscaching/shared";

const now = () => Math.floor(Date.now() / 1000);
const MAX_PAGES = 50;

export type TrustLevel = "trusted" | "unvetted" | "blocked";
export const TRUST_LEVELS: readonly TrustLevel[] = ["trusted", "unvetted", "blocked"];

interface PeerRow {
  url: string;
  instance: string | null;
  public_key: string | null;
  caches_cursor: number;
  finds_cursor: number;
  keys_cursor: number;
  tombstones_cursor: number;
  moves_cursor: number;
  bulletins_cursor: number;
  caches_cursor_id?: number | null;
  bulletins_cursor_id?: number | null;
  enabled: number;
  trust: TrustLevel;
  added_via?: string;
  endpoints?: string | null; // typed endpoint set (JSON) — see fedtransport.ts
  accept_keys?: string | null; // verified key set (JSON [{x, until?}]) — see resolvePeerKeys
  verified_via?: string | null; // identity attestation, e.g. 'ardc-lot' (never a data-trust input)
}

/** A record on its way to an applier — the decoded form of a verified fedwire frame. */
interface FeedRecord {
  type: string;
  id: string;
  cursor: number;
  data: Record<string, unknown>;
  signer?: string;
  /** The frame's signing time. */
  at?: number;
}

/** How far a frame's signing time, or a timestamp version, may run ahead of this clock. */
const MAX_FUTURE_S = 300;
/** Record types whose version is a timestamp (a cache's is a revision counter; the rest count up). */
const TIME_VERSIONED = new Set(["bulletin"]);
/** Largest pull page the consumer reads, and the most frames it accepts per requested page. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_LIMIT = 500;
/** Discovered peers, across all sources: the table never grows past this through discovery. */
const MAX_DISCOVERED = 200;

/**
 * Replay gate: a record applies only if its version is strictly greater than the last one applied
 * for its gid, it was not signed in the future, and — for a timestamp-versioned type — its version is
 * not in the future (a far-future version would freeze the mirror). Equal versions never overwrite,
 * so a replayed or forged record at a version already applied changes nothing.
 */
async function versionAdmits(env: Env, rec: FeedRecord): Promise<boolean> {
  const t = now();
  if (rec.at != null && rec.at > t + MAX_FUTURE_S) return false;
  if (TIME_VERSIONED.has(rec.type) && rec.cursor > t + MAX_FUTURE_S) return false;
  const row = await env.DB.prepare("SELECT v FROM fed_versions WHERE gid = ?").bind(rec.id).first<{ v: number }>();
  return !row || rec.cursor > row.v;
}

/** Record the version just applied for a gid (never moving it backwards). */
async function noteVersion(env: Env, gid: string, origin: string, v: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fed_versions (gid, origin, v, applied_at) VALUES (?,?,?,?)
     ON CONFLICT(gid) DO UPDATE SET v = excluded.v, origin = excluded.origin, applied_at = excluded.applied_at
     WHERE excluded.v > fed_versions.v`,
  )
    .bind(gid, origin, v, now())
    .run();
}

/** A peer-supplied timestamp, never later than this clock allows (a far-future value would pin a row). */
function clampFuture(v: unknown): number | null {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : Math.min(n, now() + MAX_FUTURE_S);
}

/** Apply one admitted record and remember its version. */
async function applyVersioned(env: Env, def: { apply: SyncDef["apply"] }, rec: FeedRecord, origin: string) {
  await def.apply(env, rec, origin);
  await noteVersion(env, rec.id, origin, rec.cursor);
}

function ours(env: Env): string | null {
  return env.INSTANCE ?? null;
}

/**
 * Seed fed_peers from the FED_PEERS env (idempotent). FED_PEERS are operator-curated, so they are
 * `manual` + `trusted` by definition — a manual peer the operator explicitly `blocked` stays
 * blocked (quarantine wins over re-seeding); `approved_at` is stamped once and preserved.
 */
async function seedPeers(env: Env): Promise<void> {
  const urls = (env.FED_PEERS ?? "")
    .split(",")
    .map((s) => trimTrailingSlashes(s.trim()))
    .filter(Boolean);
  for (const url of urls) {
    await env.DB.prepare(
      `INSERT INTO fed_peers (url, trust, added_via, approved_at) VALUES (?, 'trusted', 'manual', ?)
       ON CONFLICT(url) DO UPDATE SET
         added_via   = 'manual',
         trust       = CASE WHEN fed_peers.trust = 'blocked' THEN 'blocked' ELSE 'trusted' END,
         approved_at = COALESCE(fed_peers.approved_at, excluded.approved_at)`,
    )
      .bind(url, now())
      .run();
  }
  // registry discovery: seed peers from the verified signed registry as `unvetted` (operator
  // promotes). Carries the registry-bound key + instance so the anti-spoof check has them. No-op
  // unless FED_REGISTRY is configured + valid. INSERT OR IGNORE never downgrades a known peer.
  let registry: Map<string, RegistryEntry>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return; // an untrustworthy registry seeds nothing; each peer's sync reports the error
  }
  for (const e of registry.values()) {
    const u = e.url ? trimTrailingSlashes(e.url.trim()) : undefined;
    if (u && isInstanceId(e.instance) && e.instance !== ours(env))
      await env.DB.prepare(
        "INSERT OR IGNORE INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?,?,?, 'unvetted', 'registry')",
      )
        .bind(u, e.instance, e.key ?? null)
        .run();
  }
}

/**
 * Seed from FED_PEERS then return the **fetchable** peers — `enabled` and not `blocked` (quarantined
 * peers are never contacted). Shared by sync (mirrors trusted + unvetted) and corroboration
 * (which further narrows to `trusted` only).
 */
export async function listEnabledPeers(env: Env): Promise<PeerRow[]> {
  await seedPeers(env);
  return (await env.DB.prepare("SELECT * FROM fed_peers WHERE enabled = 1 AND trust != 'blocked'").all<PeerRow>())
    .results;
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
function syncPeerCoalesced(env: Env, p: PeerRow): Promise<PeerSyncCounts> {
  return coalesceRun(peerKey(env, p.url), () => syncPeer(env, p), peerCoalescer);
}

async function syncOnePeer(env: Env, p: PeerRow): Promise<boolean> {
  try {
    await syncPeerCoalesced(env, p);
    return true;
  } catch (e) {
    await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=?, sync_err = sync_err + 1 WHERE url=?")
      .bind((e as Error).message, now(), p.url)
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

export async function syncAllPeers(env: Env): Promise<SyncResult> {
  return coalesceRun(env, () => syncAllPeersInner(env), syncCoalescer);
}

async function syncAllPeersInner(env: Env): Promise<{
  peers: number;
  caches: number;
  finds: number;
  keys: number;
  tombstones: number;
  moves: number;
  bulletins: number;
  errors: string[];
}> {
  const peers = await listEnabledPeers(env);
  let caches = 0,
    finds = 0,
    keys = 0,
    tombstones = 0,
    moves = 0,
    bulletins = 0;
  const errors: string[] = [];
  for (const p of peers) {
    try {
      const r = await syncPeerCoalesced(env, p);
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
        .bind(msg, now(), p.url)
        .run();
    }
  }
  return { peers: peers.length, caches, finds, keys, tombstones, moves, bulletins, errors };
}

async function syncPeer(
  env: Env,
  p: PeerRow,
): Promise<{ caches: number; finds: number; keys: number; tombstones: number; moves: number; bulletins: number }> {
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
  if (wk.instance === ours(env)) return { caches: 0, finds: 0, keys: 0, tombstones: 0, moves: 0, bulletins: 0 };
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
    published: wk.publicKeys ?? (pub ? [{ x: pub }] : []),
    rotations: wk.rotations,
    prior: parseAcceptKeys(p.accept_keys),
    nowS: now(),
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
  const newActive = usableKeys(keys.accept, now());

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
  const counts: Record<string, number> = {};
  for (const def of SYNC_DEFS) {
    // iterate SYNC_DEFS to preserve the tombstones-first order
    if (!toSync.has(def.type)) {
      counts[def.type] = 0;
      continue;
    }
    counts[def.type] = await syncFeed(env, transport, p, wk.instance, newActive, def);
  }
  // observability: record a successful sync — time, count, cumulative total, per-feed breakdown
  // (surfaced via /federation/peers → last_counts)
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await env.DB.prepare(
    `UPDATE fed_peers SET last_sync=?, last_ok=?, last_error=NULL, sync_ok = sync_ok + 1,
       mirrored_total = mirrored_total + ?, last_counts = ? WHERE url=?`,
  )
    .bind(now(), now(), total, JSON.stringify({ ...counts, encoding: "cbor" }), p.url)
    .run();
  return {
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
 * a legacy peer (no version match / no list) is tried for every known feed (a 404 is handled gracefully
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

/** Which feed each sync def consumes: its endpoint, advertised capability, peer cursor, and applier. */
interface SyncDef {
  type: string;
  path: string;
  capability: string;
  cursorCol:
    "caches_cursor" | "finds_cursor" | "keys_cursor" | "tombstones_cursor" | "moves_cursor" | "bulletins_cursor";
  /** The id half of a composite cursor, for feeds whose cursor (a timestamp) can repeat. */
  cursorIdCol?: "caches_cursor_id" | "bulletins_cursor_id";
  apply(env: Env, rec: FeedRecord, origin: string): Promise<void>;
}
const SYNC_DEFS: SyncDef[] = [
  {
    type: "tombstone",
    path: "/federation/tombstones",
    capability: "tombstones",
    cursorCol: "tombstones_cursor",
    apply: applyTombstone,
  },
  {
    type: "cache",
    path: "/federation/caches",
    capability: "caches",
    cursorCol: "caches_cursor",
    cursorIdCol: "caches_cursor_id",
    apply: upsertRemoteCache,
  },
  { type: "find", path: "/federation/finds", capability: "finds", cursorCol: "finds_cursor", apply: upsertRemoteFind },
  { type: "key", path: "/federation/keys", capability: "keys", cursorCol: "keys_cursor", apply: upsertRemoteKey },
  {
    type: "account-move",
    path: "/federation/account-moves",
    capability: "moves",
    cursorCol: "moves_cursor",
    apply: upsertRemoteAccountMove,
  },
  {
    type: "bulletin",
    path: "/federation/bulletins",
    capability: "bulletins",
    cursorCol: "bulletins_cursor",
    cursorIdCol: "bulletins_cursor_id",
    apply: (env, rec, origin) => upsertRemoteBulletin(env, rec, origin),
  },
];

/**
 * Generalized feed consumer: pull CBOR sync pages, verify each fedwire frame over its bytes
 * verbatim under the peer's active keys, run the acceptance checks, apply, advance the peer cursor
 * — one loop for every record type. A 404 means the peer doesn't serve this feed → skip it
 * gracefully, never failing the whole sync. The origin is ALWAYS the verified serving peer
 * (wk.instance), never anything the payload claims — a peer inherits only its own namespace + trust.
 */
async function syncFeed(
  env: Env,
  transport: FedSyncTransport,
  p: PeerRow,
  instance: string,
  activeKeys: string[],
  def: SyncDef,
): Promise<number> {
  let cursor = (p[def.cursorCol] as number) ?? 0,
    cursorId = def.cursorIdCol ? (p[def.cursorIdCol] ?? null) : null,
    applied = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const idParam = cursorId != null ? `&sinceId=${cursorId}` : "";
    const res = await transport.get(`/federation/sync/${def.type}?since=${cursor}${idParam}&limit=${PAGE_LIMIT}`);
    if (res.status === 404) return applied; // feed not served here → forward-compat skip
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- /federation/sync/${def.type}`);
    const body = await readCappedBody(res, MAX_PAGE_BYTES);
    if (!body) throw new Error(`/federation/sync/${def.type} page too large (over ${MAX_PAGE_BYTES} bytes)`);
    const pg = decodeFedSyncPage(body);
    if (pg.frames.length > PAGE_LIMIT)
      throw new Error(`/federation/sync/${def.type} page has ${pg.frames.length} frames (asked for ${PAGE_LIMIT})`);
    for (const fb of pg.frames) {
      // each frame stands alone: a malformed or unappliable record is skipped, never a reason to
      // hold the cursor and replay the page forever
      try {
        const f = await verifyFedFrame(fb, activeKeys);
        if (!f) continue; // malformed / key outside the peer's set / bad signature
        if (f.record.origin !== instance) continue; // origin must be the verified serving peer
        if (SYNC_TYPE_BY_KIND[f.record.kind] !== def.type) continue; // a page carries only its own type
        const rec: FeedRecord = {
          type: def.type,
          id: f.record.gid,
          cursor: f.record.v,
          data: bodyFromWire(f.record.body),
          signer: f.record.signer,
          at: f.record.at,
        };
        if (!(await acceptUnsigned(env, rec, instance))) continue;
        if (!(await versionAdmits(env, rec))) continue; // replay, stale, or future-dated
        await applyVersioned(env, def, rec, instance);
        applied++;
      } catch (e) {
        console.warn(`federation: skipped a ${def.type} record from ${instance}: ${(e as Error).message}`);
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

/**
 * A federated global id (record id or tombstone target) belongs to exactly one
 * instance — its namespace prefix `<instance>:`. A peer may only serve/overwrite/tombstone ids in
 * ITS OWN namespace; anything else is an impersonation/censorship attempt. Pure + exported for test.
 */
export function idInNamespace(globalId: string | undefined | null, instance: string): boolean {
  return typeof globalId === "string" && globalId.startsWith(instance + ":");
}

/** A bulletin gid in the older `<local id>_<instance>` form, which names its instance as a suffix. */
function legacyBulletinGid(gid: string, instance: string): boolean {
  const i = gid.indexOf("_");
  return i > 0 && /^[0-9]+$/.test(gid.slice(0, i)) && gid.slice(i + 1) === instance;
}

/**
 * Is one of `targets` reachable from `from` through VALID rotation records (each new key
 * signed by its predecessor)? Verifies every published record first, then walks prev→new edges. Bounds
 * the walk to the number of records so a cyclic/oversized rotation list can't loop.
 */
export async function rotationChainReaches(
  from: string,
  targets: string[],
  rotations: RotationRecord[] | undefined,
): Promise<boolean> {
  const want = new Set(targets);
  if (want.has(from)) return true;
  const edges: Array<{ prev: string; key: string }> = [];
  for (const r of rotations ?? []) if (await verifyRotationRecord(r)) edges.push({ prev: r.prevKey, key: r.key });
  const reach = new Set([from]);
  for (let i = 0; i < edges.length; i++) {
    // at most |edges| relaxations reach every node
    let grew = false;
    for (const e of edges)
      if (reach.has(e.prev) && !reach.has(e.key)) {
        reach.add(e.key);
        grew = true;
        if (want.has(e.key)) return true;
      }
    if (!grew) break;
  }
  return false;
}

/** The record's own origin already tombstoned this global id — don't re-mirror it. Only the origin
 *  that owns a namespace can delete in it, so a tombstone row from any other origin is ignored. */
async function isTombstoned(env: Env, globalId: string, origin: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM remote_tombstones WHERE target_id = ? AND origin = ?")
    .bind(globalId, origin)
    .first<{ x: number }>());
}

/**
 * The non-cryptographic acceptance checks every carrier shares, applied after the fedwire frame's
 * signature verified. A peer may only serve records IN ITS OWN namespace, self-attested — otherwise
 * it could overwrite another instance's genuine mirror (inheriting its trust).
 */
async function acceptUnsigned(env: Env, rec: FeedRecord, instance: string): Promise<boolean> {
  // id must be the serving peer's namespace (bulletins also accept their older `<id>_<instance>` gid)
  if (!idInNamespace(rec.id, instance) && !(rec.type === "bulletin" && legacyBulletinGid(rec.id, instance)))
    return false;
  if (rec.signer !== instance) return false; // and self-attested as that peer (an empty signer attests nothing)
  if (instance === ours(env)) return false; // never mirror our own
  if (await isTombstoned(env, rec.id, instance)) return false; // purged by its origin's tombstone
  return true;
}

/**
 * Apply a peer's tombstone: verify-then-purge. Deletes any mirrored cache/find whose global id
 * matches `targetId` (the global-id namespace makes kind unambiguous), and records it so the record
 * is never re-mirrored. PII-free — the tombstone carries only signed ids + a timestamp.
 */
async function applyTombstone(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data as { kind?: string; targetId?: string; ts?: number };
  const target = d.targetId;
  if (!target) return;
  // a peer may only tombstone records in ITS OWN namespace. Without this a hostile peer
  // deletes ("censors") any instance's mirrored records network-wide and forges GDPR deletes.
  // `origin` is the verified serving peer (wk.instance), passed by syncFeed.
  if (!idInNamespace(target, origin)) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM remote_caches WHERE global_id = ?").bind(target),
    env.DB.prepare("DELETE FROM remote_finds WHERE global_id = ?").bind(target),
    env.DB.prepare("DELETE FROM remote_keys WHERE global_id = ?").bind(target),
    env.DB.prepare("DELETE FROM remote_account_moves WHERE global_id = ?").bind(target),
    env.DB.prepare(
      "INSERT OR REPLACE INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at) VALUES (?,?,?,?,?)",
    ).bind(target, origin, d.kind ?? "unknown", d.ts ?? now(), now()),
  ]);
}

/**
 * Apply a peer's account-move: record the callsign's latest known home. A peer may
 * only assert a move TO itself, and only with the mover's proof: the device-key assertion the mover
 * signed for that instance, under a key this instance knows for the callsign independently of the
 * claimant (its own registrations, or a verified key from a trusted peer). A move without such a proof
 * is refused, so no instance — alone or with an accomplice — can claim an account. Moves are ordered by
 * the proof's signing time, so an old proof re-announced later changes nothing.
 */
async function upsertRemoteAccountMove(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data as {
    callsign?: string;
    fromInstance?: string | null;
    toInstance?: string;
    ts?: number;
    proofKey?: string;
    proofSig?: string;
    proofAt?: number;
  };
  if (!d.callsign || !d.toInstance) throw new Error("account move without callsign or target");
  // a peer may only assert a move TO itself — otherwise any peer redirects any callsign to any
  // instance. And a far-future ts (e.g. 2^40) would freeze the pointer forever, so clamp it.
  if (d.toInstance !== origin) throw new Error("account move to another instance");
  const cs = d.callsign.toUpperCase();
  if (!(await moveProofValid(env, cs, origin, d))) throw new Error("account move without a verifiable proof");
  const ts = Math.min(Number(d.ts) || 0, now() + 300);
  await env.DB.prepare(
    // ordered by the proof's signing time, which the announcing instance cannot choose
    `INSERT INTO remote_account_moves (callsign, from_instance, to_instance, ts, origin, mirrored_at, global_id, proof_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(callsign) DO UPDATE SET
       from_instance = excluded.from_instance, to_instance = excluded.to_instance, ts = excluded.ts,
       origin = excluded.origin, mirrored_at = excluded.mirrored_at, global_id = excluded.global_id,
       proof_at = excluded.proof_at
     WHERE excluded.proof_at > COALESCE(remote_account_moves.proof_at, -1)`,
  )
    .bind(cs, d.fromInstance ?? null, d.toInstance, ts, origin, now(), rec.id, d.proofAt as number)
    .run();
}

/** Does a move carry the mover's signed assertion, under a key known here independently of `origin`? */
async function moveProofValid(
  env: Env,
  callsign: string,
  origin: string,
  d: { proofKey?: string; proofSig?: string; proofAt?: number },
): Promise<boolean> {
  if (typeof d.proofKey !== "string" || typeof d.proofSig !== "string" || !Number.isInteger(d.proofAt)) return false;
  // a key registered here, or a verified key a TRUSTED peer (other than the claimant) published — an
  // unvetted peer's key record costs nothing to make, so it vouches for nothing
  const known = await env.DB.prepare(
    `SELECT 1 AS x FROM callsign_keys WHERE callsign = ? AND public_key = ?
     UNION ALL SELECT 1 FROM remote_keys rk
       WHERE rk.callsign = ? AND rk.public_key = ? AND rk.origin != ? AND rk.verified = 1
         AND EXISTS (SELECT 1 FROM fed_peers fp WHERE fp.instance = rk.origin AND fp.trust = 'trusted')`,
  )
    .bind(callsign, d.proofKey, callsign, d.proofKey, origin)
    .first();
  if (!known) return false;
  try {
    const msg = new TextEncoder().encode(
      accountActionMessage({ action: "migrate", callsign, instance: origin, at: d.proofAt as number }),
    );
    return await crypto.subtle.verify("Ed25519", await importVerifyKey(d.proofKey), fromB64(d.proofSig), msg);
  } catch {
    return false;
  }
}

async function upsertRemoteKey(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
  if (typeof d.callsign !== "string" || !d.callsign || typeof d.publicKey !== "string" || !d.publicKey)
    throw new Error("key record without callsign or publicKey");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO remote_keys (global_id, origin, callsign, public_key, verified, created_at, mirrored_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(rec.id, origin, d.callsign ?? null, d.publicKey ?? null, d.verified ? 1 : 0, d.createdAt ?? null, now())
    .run();
}

// ---- store-and-forward receive: a federation bulletin that arrived over the FBB mesh ----

/** Fedwire record kind → the sync feed that applies it; kinds with no local applier map to null. */
const SYNC_TYPE_BY_KIND: Record<FedRecordKind, string | null> = {
  cache: "cache",
  find: "find",
  key: "key",
  tombstone: "tombstone",
  accountMove: "account-move",
  bulletin: "bulletin",
  peer: null, // peer-announce carries no mirror record
  relayQuery: null, // relay traffic is dispatched to the relay handler, not a mirror applier
  relayAnswer: null,
  corroborationQuery: null, // a live request/response exchange, never carried as a mirror record
  corroboration: null,
};
const SYNC_DEF_BY_TYPE = new Map(SYNC_DEFS.map((d) => [d.type, d]));

export interface FedBbsApplyResult {
  /** Was the body a federation bulletin at all (vs an ordinary BBS message)? */
  federation: boolean;
  /** The bulletin's content-addressed BID — the caller dedups the mesh by this. */
  bid: string | null;
  /** Frames verified, accepted, and applied to a mirror. */
  applied: number;
  /** Frames dropped because the claimed origin is unknown (no pinned key, no registry binding) or blocked. */
  quarantined: number;
  /** Frames dropped as malformed, badly signed, or violating the origin's namespace. */
  rejected: number;
}

export interface FedFramesResult {
  applied: number;
  quarantined: number;
  rejected: number;
}

/**
 * The trust-gated apply pipeline every non-HTTP carrier feeds — FBB bulletins, HF beacon datagrams,
 * connected-mode circuit pages. Each frame is verified against ITS CLAIMED ORIGIN's keys — the key
 * we last pinned for that peer plus any the signed registry binds to it — then run through the SAME
 * namespace / self-attest / tombstone checks and the idempotent-by-gid appliers as an HTTP pull, so
 * carriers can never diverge. A frame from an origin the instance does not already know, or one an
 * operator has blocked, is quarantined and never applied: receiving a frame over any carrier
 * introduces no peer and lifts no trust. Apply is idempotent by global id, so frames delivered more
 * than once (multi-path flood, replays) converge.
 */
export async function applyFedFrames(env: Env, frames: Uint8Array[]): Promise<FedFramesResult> {
  let registry: Map<string, RegistryEntry>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return { applied: 0, quarantined: frames.length, rejected: 0 }; // no trustworthy registry → apply nothing
  }
  const keyCache = new Map<string, string[] | "blocked">();
  let applied = 0,
    quarantined = 0,
    rejected = 0;
  for (const fb of frames) {
    // read the claimed origin as a key SELECTOR — a valid signature under a key we independently
    // bind to that origin is still required below, so a forged claim buys nothing.
    let origin: string;
    try {
      origin = decodeFedFrame(fb).record.origin;
    } catch {
      rejected++;
      continue;
    }
    if (origin === ours(env)) {
      rejected++;
      continue; // never mirror our own records back in
    }
    const allowed = await originKeys(env, origin, registry, keyCache);
    if (allowed === "blocked" || !allowed.length) {
      quarantined++;
      continue; // blocked peer, or an origin we have no key for → can't (and won't) apply
    }
    const f = await verifyFedFrame(fb, allowed);
    if (!f || f.record.origin !== origin) {
      rejected++;
      continue; // bad signature, key outside the origin's set, or payload origin mismatch
    }
    if (f.record.kind === "relayQuery" || f.record.kind === "relayAnswer") {
      if (!idInNamespace(f.record.gid, origin)) {
        rejected++;
        continue;
      }
      const r = await handleRelayFrame(env, f.record);
      if (r === "applied") applied++;
      else if (r === "rejected") rejected++;
      continue; // "elsewhere": addressed to another instance riding the same flood — not ours to count
    }
    if (f.record.kind === "peer") {
      if (!idInNamespace(f.record.gid, origin)) {
        rejected++;
        continue;
      }
      applied += (await applyPeerAnnounce(env, f.record, origin)) ? 1 : 0;
      continue;
    }
    const def = SYNC_DEF_BY_TYPE.get(SYNC_TYPE_BY_KIND[f.record.kind] ?? "");
    if (!def) {
      rejected++;
      continue;
    }
    const rec: FeedRecord = {
      type: def.type,
      id: f.record.gid,
      cursor: f.record.v,
      data: bodyFromWire(f.record.body),
      signer: f.record.signer,
      at: f.record.at,
    };
    if (!(await acceptUnsigned(env, rec, origin))) {
      rejected++;
      continue; // gid outside origin's namespace / not self-attested / tombstoned
    }
    if (!(await versionAdmits(env, rec))) {
      rejected++;
      continue; // a replay, a record at a version already applied, or future-dated
    }
    try {
      await applyVersioned(env, def, rec, origin);
      applied++;
    } catch {
      rejected++; // a malformed record never aborts the frames after it
    }
  }
  return { applied, quarantined, rejected };
}

/**
 * A verified peer-announce (an HF presence beacon) refreshes a KNOWN peer's self-attested endpoint
 * set — addressing only, never a trust input, and strictly an UPDATE: hearing an announce never
 * inserts a peer, so a beacon can't introduce anyone (RX ≠ trust). Endpoints are re-validated
 * through the typed validator so a malformed address never rides an announce in.
 */
async function applyPeerAnnounce(env: Env, rec: FedRecord, origin: string): Promise<boolean> {
  const addresses = parseEndpoints(rec.body.addresses);
  if (!addresses.length) return false;
  const res = await env.DB.prepare("UPDATE fed_peers SET endpoints=? WHERE instance=? AND trust != 'blocked'")
    .bind(JSON.stringify(addresses), origin)
    .run();
  return !!res.meta.changes;
}

/**
 * Receive a store-and-forward federation bulletin off the FBB mesh: decode the `ACSFED` envelope,
 * then feed its frames through the shared trust-gated pipeline. The caller dedups by the
 * content-addressed BID before invoking (a re-flooded copy never re-applies).
 */
export async function applyFedBbsBulletin(env: Env, body: string): Promise<FedBbsApplyResult> {
  const batch = decodeFedBbsBatch(body);
  if (!batch) return { federation: false, bid: null, applied: 0, quarantined: 0, rejected: 0 };
  const r = await applyFedFrames(env, batch.frames);
  return { federation: true, bid: batch.bid, ...r };
}

/**
 * Relay traffic off the store-and-forward carrier. A `relayQuery` addressed to this instance is
 * answered from the local DB and the signed `relayAnswer` goes back onto the mesh; a `relayAnswer`
 * addressed to this instance lands in the relay queue for its requester, scoped to rows addressed
 * to the ANSWERING instance — a spoke can only ever answer its own queue, the same rule the HTTP
 * leg enforces with the per-spoke token. Frames addressed to other instances ride the same flood
 * legitimately; they are simply not ours.
 */
/** How long a relay frame stays answerable: store-and-forward is slow, but not this slow. */
const RELAY_FRAME_MAX_AGE_S = 3 * 86400;

async function handleRelayFrame(env: Env, rec: FedRecord): Promise<"applied" | "rejected" | "elsewhere"> {
  const us = (ours(env) ?? "").toLowerCase();
  const target = typeof rec.body.target === "string" ? rec.body.target.toLowerCase() : "";
  if (!us || target !== us) return "elsewhere";
  const id = Number(rec.body.id);
  if (!Number.isInteger(id) || id <= 0) return "rejected";
  // each relay frame is acted on once and only while fresh: a replayed query would otherwise
  // trigger a new answer bulletin every time it is re-flooded
  const t = now();
  if (rec.at > t + MAX_FUTURE_S || rec.at < t - RELAY_FRAME_MAX_AGE_S) return "rejected";
  const seen = await env.DB.prepare("SELECT 1 AS x FROM fed_versions WHERE gid = ?").bind(rec.gid).first();
  if (seen) return "rejected";
  const r = await actOnRelayFrame(env, rec, us, id);
  // remembered only once acted on, so a query whose answer could not be sent can still be answered
  if (r === "applied") await noteVersion(env, rec.gid, rec.origin, rec.v);
  return r;
}

async function actOnRelayFrame(
  env: Env,
  rec: FedRecord,
  us: string,
  id: number,
): Promise<"applied" | "rejected" | "elsewhere"> {
  if (rec.kind === "relayQuery") {
    const paramsJson = typeof rec.body.paramsJson === "string" ? rec.body.paramsJson : "{}";
    let params: unknown;
    try {
      params = JSON.parse(paramsJson);
    } catch {
      return "rejected";
    }
    const q = parseRelayQuery({ kind: rec.body.kind, params });
    if (!q) return "rejected";
    const result = await answerRelayQuery(q, { feed: (p) => feedSource(env, p) });
    const at = now();
    const frame = await signFedRecord(env, {
      kind: "relayAnswer",
      gid: `${us}:relay:${id}:a`,
      origin: us,
      v: at,
      at,
      signer: us,
      body: { id, target: rec.origin, resultJson: JSON.stringify(result) },
    });
    if (!frame) return "rejected"; // an unsigned spoke cannot answer over the air
    await enqueueAcsfedBulletin(env, [frame]);
    return "applied";
  }

  if (typeof rec.body.resultJson !== "string") return "rejected";
  let result: unknown;
  try {
    result = JSON.parse(rec.body.resultJson);
  } catch {
    return "rejected";
  }
  const res = await env.DB.prepare(
    "UPDATE fed_relay_queue SET status='answered', answer=?, answered_at=? WHERE id=? AND instance=? AND status IN ('queued','leased','dispatched')",
  )
    .bind(JSON.stringify(result), now(), id, rec.origin.toLowerCase())
    .run();
  return res.meta.changes ? "applied" : "rejected";
}

/**
 * The keys a claimed origin's frames may be signed under: the key set last verified for its live
 * peer row (the pin plus predecessors inside their rotation grace, see resolvePeerKeys) plus the key
 * the signed registry binds to its instance id. An instance has at most one live (non-blocked) row;
 * `"blocked"` when only blocked rows name it, an empty set when the origin is unknown — either way
 * its frames never apply. A disabled row (never pulled, such as a push-to-hub spoke) still names its
 * keys: `enabled` decides whether we fetch from a peer, not who it is.
 */
async function originKeys(
  env: Env,
  origin: string,
  registry: Map<string, RegistryEntry>,
  cache: Map<string, string[] | "blocked">,
): Promise<string[] | "blocked"> {
  const hit = cache.get(origin);
  if (hit !== undefined) return hit;
  const row = await env.DB.prepare(
    `SELECT public_key, accept_keys, trust FROM fed_peers WHERE instance = ?
      ORDER BY trust = 'blocked', url LIMIT 1`,
  )
    .bind(origin)
    .first<{ public_key: string | null; accept_keys: string | null; trust: TrustLevel }>();
  if (row?.trust === "blocked") {
    cache.set(origin, "blocked");
    return "blocked";
  }
  const keys = new Set<string>();
  if (row) {
    const accept = parseAcceptKeys(row.accept_keys);
    if (accept.length) for (const k of usableKeys(accept, now())) keys.add(k);
    else if (row.public_key) keys.add(row.public_key);
  }
  const regKey = registry.get(origin)?.key;
  if (regKey) keys.add(regKey);
  const arr = [...keys];
  cache.set(origin, arr);
  return arr;
}

/**
 * The keys an origin's live exchanges (corroboration) verify under — the same accept set every
 * carrier uses. Empty when the origin is unknown, blocked, or the registry is misconfigured.
 */
export async function keysForOrigin(env: Env, origin: string): Promise<string[] | "blocked"> {
  let registry: Map<string, RegistryEntry>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return [];
  }
  return originKeys(env, origin, registry, new Map());
}

export async function upsertRemoteCache(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
  // version-monotonic — a replayed OLDER signed record (stale cursor, hostile replay)
  // must never roll a mirror back, e.g. to pre-redaction content. Only a record at least as new
  // (by the origin's own updated_at) may overwrite.
  await env.DB.prepare(
    `INSERT INTO remote_caches
       (global_id, origin, code, owner_call, title, type, status, difficulty, terrain, lat, lon,
        station_call, source, external_id, hint, description, min_trust, created_at, updated_at, mirrored_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(global_id) DO UPDATE SET
       origin=excluded.origin, code=excluded.code, owner_call=excluded.owner_call,
       title=excluded.title, type=excluded.type, status=excluded.status,
       difficulty=excluded.difficulty, terrain=excluded.terrain, lat=excluded.lat, lon=excluded.lon,
       station_call=excluded.station_call, source=excluded.source, external_id=excluded.external_id,
       hint=excluded.hint, description=excluded.description, min_trust=excluded.min_trust,
       created_at=excluded.created_at, updated_at=excluded.updated_at, mirrored_at=excluded.mirrored_at
     WHERE COALESCE(excluded.updated_at, 0) >= COALESCE(remote_caches.updated_at, 0)`,
  )
    .bind(
      rec.id,
      origin,
      d.code ?? null,
      d.ownerCall ?? null,
      d.title ?? null,
      d.type ?? null,
      d.status ?? null,
      d.difficulty ?? null,
      d.terrain ?? null,
      d.lat ?? null,
      d.lon ?? null,
      d.stationCall ?? null,
      d.source ?? null,
      d.externalId ?? null,
      d.hint ?? null,
      d.description ?? null,
      d.minTrust ?? null,
      d.createdAt ?? null,
      clampFuture(d.updatedAt),
      now(),
    )
    .run();
}

export async function upsertRemoteFind(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
  // finds are events keyed by the origin's own ts — same monotonic rule as caches so a
  // replayed older copy (e.g. with a since-redacted comment) can't overwrite the current mirror.
  await env.DB.prepare(
    `INSERT INTO remote_finds
       (global_id, origin, cache_global_id, cache_code, logger_call, ts, log_type,
        verified, tier, verify_method, distance_m, comment, mirrored_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(global_id) DO UPDATE SET
       origin=excluded.origin, cache_global_id=excluded.cache_global_id, cache_code=excluded.cache_code,
       logger_call=excluded.logger_call, ts=excluded.ts, log_type=excluded.log_type,
       verified=excluded.verified, tier=excluded.tier, verify_method=excluded.verify_method,
       distance_m=excluded.distance_m, comment=excluded.comment, mirrored_at=excluded.mirrored_at
     WHERE COALESCE(excluded.ts, 0) >= COALESCE(remote_finds.ts, 0)`,
  )
    .bind(
      rec.id,
      origin,
      d.cacheId ?? null,
      d.cacheCode ?? null,
      d.loggerCall ?? null,
      clampFuture(d.ts),
      d.logType ?? null,
      d.verified ? 1 : 0,
      d.tier ?? null,
      d.verifyMethod ?? null,
      d.distanceM ?? null,
      d.comment ?? null,
      now(),
    )
    .run();
}

// ---- endpoints ----
/** POST /federation/sync — run a pull from every peer now (the scheduled sync runs the same). Operator-only. */
export async function handleFederationSync(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const summary = await syncAllPeers(env);
  return json({ ok: true, ...summary });
}

export async function handleFederationPeers(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate; // operator observability
  await seedPeers(env);
  const rows = (
    await env.DB.prepare(
      `SELECT url, instance, public_key IS NOT NULL AS signed, trust, added_via, approved_at,
            rep_confirmed, rep_failed, caches_cursor, finds_cursor, keys_cursor, tombstones_cursor, moves_cursor,
            enabled, last_sync, last_ok, last_error, sync_ok, sync_err, mirrored_total, last_counts
       FROM fed_peers ORDER BY url`,
    ).all<Record<string, unknown>>()
  ).results;
  // derive a health signal + error rate so an operator scans state without doing the math.
  const peers = rows.map((p) => {
    const okN = Number(p.sync_ok ?? 0),
      errN = Number(p.sync_err ?? 0);
    const lastErrored = !!p.last_error && (!p.last_ok || Number(p.last_sync ?? 0) > Number(p.last_ok ?? 0));
    const health = p.trust === "blocked" ? "blocked" : !p.last_sync ? "new" : lastErrored ? "error" : "ok";
    return {
      ...p,
      lastCounts: p.last_counts ? JSON.parse(p.last_counts as string) : null,
      errorRate: okN + errN > 0 ? errN / (okN + errN) : 0,
      health,
    };
  });
  return json({ peers });
}

/**
 * Operator control: set a peer's trust level. Sysop-only (signed-in instance operator) or the
 * operator secret, so the operator's Instance-admin → Federation surface can promote (`trusted`), demote
 * (`unvetted`), or quarantine (`blocked`) a peer. Promotion stamps `approved_at` once.
 */
export async function handlePeerTrust(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const b = (await req.json().catch(() => null)) as { url?: string; trust?: string } | null;
  const trust = b?.trust as TrustLevel | undefined;
  if (!b?.url || !trust || !TRUST_LEVELS.includes(trust))
    return json({ ok: false, error: "url + trust (trusted|unvetted|blocked) required" }, { status: 400 });
  const url = trimTrailingSlashes(b.url.trim());
  const exists = await env.DB.prepare("SELECT url FROM fed_peers WHERE url = ?").bind(url).first<{ url: string }>();
  if (!exists) return json({ ok: false, error: "unknown peer" }, { status: 404 });
  try {
    await env.DB.prepare(
      // choosing a level for a discovered peer (which starts disabled) is the operator enabling it
      `UPDATE fed_peers SET trust = ?,
         approved_at = CASE WHEN ? = 'trusted' THEN COALESCE(approved_at, ?) ELSE approved_at END,
         enabled = CASE WHEN added_via = 'discovered' AND ? != 'blocked' THEN 1 ELSE enabled END
       WHERE url = ?`,
    )
      .bind(trust, trust, now(), trust, url)
      .run();
  } catch (e) {
    // unblocking a row whose instance id another live row already holds
    if (/UNIQUE/i.test((e as Error).message))
      return json(
        { ok: false, error: "another peer holds this instance id — block or remove it first" },
        { status: 409 },
      );
    throw e;
  }
  return json({ ok: true, url, trust });
}

// ---- push-to-hub: NAT/firewall peers contribute without inbound reachability ----

/** type → applier, reusing the exact mirror path as pull-sync (display-only, idempotent by global id). */
const APPLIERS: Record<string, (env: Env, rec: FeedRecord, origin: string) => Promise<void>> = Object.fromEntries(
  SYNC_DEFS.map((d) => [d.type, d.apply]),
);

/** The feeds a spoke pushes — tombstones first, matching the sync ordering so a delete suppresses re-mirror. */
const PUSH_FEEDS: FeedServeDef[] = [TOMBSTONE_FEED, CACHE_FEED, FIND_FEED, KEY_FEED];
const PUSH_CURSORS = new Map<string, { cursor: number; id?: number }>(); // "hub|type" -> last pushed position (in-memory; re-push on restart is idempotent)
/** Largest submission body the hub reads: a full page of frames fits well inside it. */
const MAX_SUBMIT_BYTES = 4 * 1024 * 1024;

/**
 * HUB endpoint: accept a spoke's signed records and mirror them as if we had pulled them
 * (push-mode mirroring — same remote_* tables, same display-only semantics). Secret-gated; optionally
 * restricted to an instance allowlist. Each record is verified against the supplied key and MUST name
 * the submitter as its signer, so a spoke can only contribute records as ITSELF — never impersonate
 * another instance. A spoke that rotated its key sends its rotation records in `x-fed-rotations`.
 */
export async function handleFederationSubmit(req: Request, env: Env): Promise<Response> {
  const secret = env.FED_SUBMIT_SECRET;
  if (!secret) return json({ ok: false, error: "submit disabled" }, { status: 403 });
  if (!secretOk(req.headers.get("x-fed-secret"), secret))
    return json({ ok: false, error: "unauthorized" }, { status: 401 });

  // A submission is a sync page of fedwire frames — the same signed bytes every other carrier
  // moves. The page's instance declares the submitter; every frame must be signed by ONE key (a
  // submission is one spoke), verified over the frame bytes verbatim.
  if (!(req.headers.get("content-type") ?? "").includes("application/cbor"))
    return json({ ok: false, error: "submit is application/cbor (a fedwire sync page)" }, { status: 415 });
  const body = await readCappedBody(req, MAX_SUBMIT_BYTES);
  if (!body) return json({ ok: false, error: "submission too large" }, { status: 413 });
  let page: ReturnType<typeof decodeFedSyncPage>;
  try {
    page = decodeFedSyncPage(body);
  } catch {
    return json({ ok: false, error: "not a CBOR sync page" }, { status: 400 });
  }
  if (!isInstanceId(page.instance))
    return json({ ok: false, error: "submitter instance id is not a hostname" }, { status: 400 });
  let rotations: RotationRecord[] = [];
  try {
    const h = req.headers.get("x-fed-rotations");
    if (h && h.length <= 16_384) rotations = (JSON.parse(h) as RotationRecord[]).slice(0, 32);
  } catch {
    return json({ ok: false, error: "x-fed-rotations is not a JSON array of rotation records" }, { status: 400 });
  }
  const records: FeedRecord[] = [];
  let rejected = 0;
  let submitKey: string | null = null;
  for (const fb of page.frames) {
    let signerKey: string;
    try {
      signerKey = decodeFedFrame(fb).signerKey;
    } catch {
      rejected++;
      continue;
    }
    submitKey ??= signerKey;
    const f = await verifyFedFrame(fb, [submitKey]);
    if (!f || f.record.origin !== page.instance) {
      rejected++;
      continue; // bad signature, a second key smuggled into the batch, or a foreign origin
    }
    const type = SYNC_TYPE_BY_KIND[f.record.kind];
    if (!type) {
      rejected++;
      continue;
    }
    records.push({
      type,
      id: f.record.gid,
      cursor: f.record.v,
      data: bodyFromWire(f.record.body),
      signer: f.record.signer,
      at: f.record.at,
    });
  }
  if (!submitKey) return json({ ok: false, error: "no verifiable frames" }, { status: 400 });
  return submitRecords(env, page.instance, submitKey, records, rejected, rotations);
}

/**
 * The submit core: allowlist, the registry + TOFU key binding, spoke registration, and the
 * per-record acceptance rules. Frames arrive pre-verified over their bytes.
 */
async function submitRecords(
  env: Env,
  instance: string,
  publicKey: string,
  records: FeedRecord[],
  preRejected: number,
  rotations: RotationRecord[] = [],
): Promise<Response> {
  if (instance === ours(env)) return json({ ok: false, error: "cannot submit as this instance" }, { status: 400 });
  const allow = (env.FED_SUBMIT_INSTANCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length && !allow.includes(instance))
    return json({ ok: false, error: "instance not allowed" }, { status: 403 });

  // A secret-holder must not be able to impersonate a KNOWN instance. The signed registry binding
  // wins; otherwise the submitted key must be one the hub already verified for this instance, under
  // ANY row — a pulled peer, a 44net or registry entry, or an earlier submission. A shared secret is
  // not an identity, so a blocked instance stays out and a new spoke enters unvetted until the
  // operator promotes it.
  let registry: Map<string, RegistryEntry>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return json({ ok: false, error: "federation registry is misconfigured on this hub" }, { status: 503 });
  }
  const regEntry = registry.get(instance);
  if (regEntry?.key && regEntry.key !== publicKey)
    return json({ ok: false, error: "submitted key does not match the registry for this instance" }, { status: 403 });
  const known = (
    await env.DB.prepare("SELECT url, public_key, accept_keys, trust FROM fed_peers WHERE instance = ?")
      .bind(instance)
      .all<{ url: string; public_key: string | null; accept_keys: string | null; trust: TrustLevel }>()
  ).results;
  if (known.some((r) => r.trust === "blocked"))
    return json({ ok: false, error: "instance is blocked on this hub" }, { status: 403 });
  for (const r of known) {
    const accept = parseAcceptKeys(r.accept_keys);
    const keys = accept.length ? usableKeys(accept, now()) : r.public_key ? [r.public_key] : [];
    if (!keys.length || keys.includes(publicKey)) continue;
    // A spoke that rotated proves it the same way a pulled peer does: rotation records (sent in
    // x-fed-rotations) leading from its pinned key to the new one. Only its own submit row moves.
    if (r.url === `submit:${instance}` && r.public_key) {
      const moved = await resolvePeerKeys({
        pinned: r.public_key,
        current: publicKey,
        published: [{ x: publicKey }, ...accept.filter((k) => k.x !== publicKey)],
        rotations,
        prior: accept,
        nowS: now(),
        graceDays: env.FED_ROTATION_GRACE_DAYS ? Number(env.FED_ROTATION_GRACE_DAYS) : undefined,
      });
      if (moved.ok) {
        await env.DB.prepare("UPDATE fed_peers SET public_key = ?, accept_keys = ? WHERE url = ?")
          .bind(moved.pin, JSON.stringify(moved.accept), r.url)
          .run();
        continue;
      }
    }
    return json({ ok: false, error: "submitted key does not match the key known for this instance" }, { status: 403 });
  }

  // Register a new spoke as a never-pulled peer so its mirrored records carry a uniform trust
  // binding: enabled=0 keeps it out of the pull set, and the synthetic `submit:<instance>` url
  // marks how it arrived.
  if (!known.length)
    await env.DB.prepare(
      "INSERT OR IGNORE INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via, enabled) VALUES (?, ?, ?, ?, 'unvetted', 'submitted', 0)",
    )
      .bind(`submit:${instance}`, instance, publicKey, JSON.stringify([{ x: publicKey }]))
      .run();

  let applied = 0,
    rejected = preRejected;
  for (const rec of records) {
    const apply = APPLIERS[rec.type];
    if (!apply || rec.signer !== instance) {
      rejected++;
      continue;
    } // unknown type / wrong (or absent) signer
    if (!idInNamespace(rec.id, instance)) {
      rejected++;
      continue;
    } // only the submitter's own namespace
    if (await isTombstoned(env, rec.id, instance)) {
      rejected++;
      continue;
    } // already purged by a tombstone
    if (!(await versionAdmits(env, rec))) {
      rejected++;
      continue; // a replay, a record at a version already applied, or future-dated
    }
    try {
      await applyVersioned(env, { apply }, rec, instance);
      applied++;
    } catch {
      rejected++; // a malformed record never aborts the rest of the submission
    }
  }
  return json({ ok: true, applied, rejected });
}

/**
 * SPOKE side: push our signed records to a configured hub (push-mode mirroring) when we can't be
 * pulled — a sync page of fedwire frames, the same signed bytes as every other carrier. Incremental
 * via in-memory cursors; idempotent (the hub upserts by global id), so a restart that re-pushes
 * from 0 is harmless. No-op unless FED_HUB_URL + FED_SUBMIT_SECRET + a signing key are present.
 */
export async function pushToHub(
  env: Env,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fedFetch(env, u, i),
): Promise<{ pushed: number } | null> {
  const hub = env.FED_HUB_URL ? trimTrailingSlashes(env.FED_HUB_URL) : undefined;
  const secret = env.FED_SUBMIT_SECRET;
  if (!hub || !secret || !env.INSTANCE) return null;
  let pushed = 0;
  for (const def of PUSH_FEEDS) {
    const ckey = `${hub}|${def.type}`;
    let { cursor, id } = PUSH_CURSORS.get(ckey) ?? { cursor: 0 };
    for (let page = 0; page < MAX_PAGES; page++) {
      const built = await buildFedFrames(env, env.INSTANCE, def.type, cursor, 500, id);
      if (!built) return null; // no signing key — nothing verifiable to push
      if (!built.frames.length) break;
      const complete = built.frames.length < 500;
      const res = await fetchFn(`${hub}/federation/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/cbor",
          "x-fed-secret": secret,
          // our rotation records, so a hub that pinned an earlier key can follow the rotation
          ...(env.FED_ROTATIONS ? { "x-fed-rotations": env.FED_ROTATIONS } : {}),
        },
        body: encodeFedSyncPage(env.INSTANCE, built.nextCursor, complete, built.frames, built.nextId) as BodyInit,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { pushed }; // stop; retry next cycle from the same cursor
      // as on the pull side, the id tie-breaker is kept only while more pages of this pass remain
      PUSH_CURSORS.set(ckey, { cursor: built.nextCursor, id: complete ? undefined : built.nextId });
      pushed += built.frames.length;
      if (complete || (built.nextCursor === cursor && built.nextId === id)) break;
      cursor = built.nextCursor;
      id = built.nextId;
    }
  }
  return { pushed };
}
