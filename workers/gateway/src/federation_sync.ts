// SPDX-License-Identifier: AGPL-3.0-or-later
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
  activeFedKeys,
  type FedPublicKey,
  loadRegistry,
  registryKeyAllowed,
  CACHE_FEED,
  FIND_FEED,
  KEY_FEED,
  type FeedServeDef,
  verifyRotationRecord,
  type RotationRecord,
  type RegistryEntry,
} from "./federation.js";
import { TOMBSTONE_FEED } from "./tombstones.js";
import { upsertRemoteBulletin } from "./bbs.js";
import { syncTransportFor, type FedSyncTransport } from "./fedtransport.js";
import { verifyFedFrame, signFedRecord } from "./fedcbor.js";
import { decodeFedSyncPage, encodeFedSyncPage, buildFedFrames, bodyFromWire } from "./fedsync.js";
import { answerRelayQuery, feedSource, parseRelayQuery } from "./relay.js";
import { enqueueAcsfedBulletin } from "./fedforward.js";
import {
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
  enabled: number;
  trust: TrustLevel;
  added_via?: string;
  endpoints?: string | null; // typed endpoint set (JSON) — see fedtransport.ts
  verified_via?: string | null; // identity attestation, e.g. 'ardc-lot' (never a data-trust input)
}

/** A record on its way to an applier — the decoded form of a verified fedwire frame. */
interface FeedRecord {
  type: string;
  id: string;
  cursor: number;
  data: Record<string, unknown>;
  signer?: string;
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
    .map((s) => s.trim().replace(/\/+$/, ""))
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
  for (const e of (await loadRegistry(env)).values()) {
    const u = e.url?.trim().replace(/\/+$/, "");
    if (u && e.instance !== ours(env))
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
  try {
    await syncPeer(env, p);
    return true;
  } catch (e) {
    await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=?, sync_err = sync_err + 1 WHERE url=?")
      .bind((e as Error).message, now(), p.url)
      .run();
    return false;
  }
}

// Node/Bun drive a periodic federation-sync interval AND the nightly `runScheduled` (which
// also calls this) — near boot they can overlap and double-pull every peer. Coalesce per-env: a caller
// arriving while a run is in flight *joins* it and gets the same real result rather than starting a
// second concurrent pull. An explicit /federation/sync therefore still returns real counts even if it
// races a background run. Sequential (awaited) calls are unaffected.
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
const inFlightSync = new WeakMap<object, Promise<SyncResult>>();

export async function syncAllPeers(env: Env): Promise<SyncResult> {
  const existing = inFlightSync.get(env);
  if (existing) return existing;
  const p = syncAllPeersInner(env).finally(() => inFlightSync.delete(env));
  inFlightSync.set(env, p);
  return p;
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
      const r = await syncPeer(env, p);
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
  const transport = syncTransportFor(p);
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
  const pinned = p.public_key; // the key we last trusted for this peer (null on first sight)
  const newActive = activeFedKeys(wk.publicKeys ?? (pub ? [{ x: pub }] : []), now());

  // never blindly re-pin. Once a peer is signed we refuse to drop to unsigned, and we only
  // accept a *changed* key if the peer proves continuity with a rotation-record chain from the pinned
  // key (each new key signed by its predecessor). A hijacked domain that simply swaps keys is rejected.
  if (pinned) {
    if (!pub)
      throw new Error(`peer ${wk.instance} regressed to unsigned — refusing (was pinned ${pinned.slice(0, 12)}…)`);
    if (!newActive.includes(pinned) && !(await rotationChainReaches(pinned, newActive, wk.rotations)))
      throw new Error(`peer ${wk.instance} key changed without a valid rotation proof — refusing (possible hijack)`);
  }
  await env.DB.prepare("UPDATE fed_peers SET instance=?, public_key=? WHERE url=?")
    .bind(wk.instance ?? null, pub, p.url)
    .run();

  // opt-in transitive discovery: adopt the peers this peer advertises (capped, deduped by INSERT OR IGNORE).
  // Discovered peers start `unvetted` — mirrored-but-flagged, excluded from corroboration until an
  // operator promotes them. INSERT OR IGNORE never downgrades a peer already known/trusted.
  if (env.FED_DISCOVER) {
    for (const url of (wk.peers ?? []).slice(0, 50)) {
      const u = String(url).trim().replace(/\/+$/, "");
      if (u && u !== base)
        await env.DB.prepare(
          "INSERT OR IGNORE INTO fed_peers (url, trust, added_via) VALUES (?, 'unvetted', 'discovered')",
        )
          .bind(u)
          .run();
    }
  }

  // never mirror ourselves
  if (wk.instance && wk.instance === ours(env))
    return { caches: 0, finds: 0, keys: 0, tombstones: 0, moves: 0, bulletins: 0 };

  // anti-spoof: if a signed registry binds this instance to a key, the peer's published keys MUST
  // include it — else someone is impersonating a known instance id. Unregistered peers fall back to TOFU.
  const registryEntry = (await loadRegistry(env)).get(wk.instance);
  if (!registryKeyAllowed(registryEntry, newActive))
    throw new Error(`registry key mismatch for ${wk.instance} — refusing to mirror (possible spoof)`);

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
    applied = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await transport.get(`/federation/sync/${def.type}?since=${cursor}&limit=500`);
    if (res.status === 404) return applied; // feed not served here → forward-compat skip
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- /federation/sync/${def.type}`);
    const pg = decodeFedSyncPage(new Uint8Array(await res.arrayBuffer()));
    for (const fb of pg.frames) {
      const f = await verifyFedFrame(fb, activeKeys);
      if (!f) continue; // malformed / key outside the peer's set / bad signature
      if (f.record.origin !== instance) continue; // origin must be the verified serving peer
      const rec: FeedRecord = {
        type: def.type,
        id: f.record.gid,
        cursor: f.record.v,
        data: bodyFromWire(f.record.body),
        signer: f.record.signer,
      };
      if (!(await acceptUnsigned(env, rec, instance))) continue;
      await def.apply(env, rec, instance);
      applied++;
    }
    const next = pg.nextCursor ?? cursor;
    await env.DB.prepare(`UPDATE fed_peers SET ${def.cursorCol}=? WHERE url=?`).bind(next, p.url).run();
    if (pg.complete || next === cursor) break;
    cursor = next;
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

/** A peer already tombstoned this global id — don't re-mirror it. */
async function isTombstoned(env: Env, globalId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM remote_tombstones WHERE target_id = ?")
    .bind(globalId)
    .first<{ x: number }>());
}

/**
 * The non-cryptographic acceptance checks every carrier shares, applied after the fedwire frame's
 * signature verified. A peer may only serve records IN ITS OWN namespace, self-attested — otherwise
 * it could overwrite another instance's genuine mirror (inheriting its trust).
 */
async function acceptUnsigned(env: Env, rec: FeedRecord, instance: string): Promise<boolean> {
  if (!idInNamespace(rec.id, instance)) return false; // id must be the serving peer's namespace
  if (rec.signer && rec.signer !== instance) return false; // and self-attested as that peer
  if (rec.signer && rec.signer === ours(env)) return false; // never mirror our own
  if (await isTombstoned(env, rec.id)) return false; // purged by a peer tombstone
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
    env.DB.prepare(
      "INSERT OR REPLACE INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at) VALUES (?,?,?,?,?)",
    ).bind(target, origin, d.kind ?? "unknown", d.ts ?? now(), now()),
  ]);
}

/** Apply a peer's account-move: record the callsign's latest known home, last-writer by ts. */
async function upsertRemoteAccountMove(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data as { callsign?: string; fromInstance?: string | null; toInstance?: string; ts?: number };
  if (!d.callsign || !d.toInstance) return;
  // a peer may only assert a move TO itself — otherwise any peer redirects any callsign to
  // any instance. And a far-future ts (e.g. 2^40) would freeze the pointer forever, so clamp it.
  if (d.toInstance !== origin) return;
  const ts = Math.min(Number(d.ts) || 0, now() + 300);
  await env.DB.prepare(
    `INSERT INTO remote_account_moves (callsign, from_instance, to_instance, ts, origin, mirrored_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(callsign) DO UPDATE SET
       from_instance = excluded.from_instance, to_instance = excluded.to_instance,
       ts = excluded.ts, origin = excluded.origin, mirrored_at = excluded.mirrored_at
     WHERE excluded.ts >= remote_account_moves.ts`,
  )
    .bind(d.callsign.toUpperCase(), d.fromInstance ?? null, d.toInstance, ts, origin, now())
    .run();
}

async function upsertRemoteKey(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
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
  const registry = await loadRegistry(env);
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
    };
    if (!(await acceptUnsigned(env, rec, origin))) {
      rejected++;
      continue; // gid outside origin's namespace / not self-attested / tombstoned
    }
    await def.apply(env, rec, origin);
    applied++;
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
  const res = await env.DB.prepare("UPDATE fed_peers SET endpoints=? WHERE instance=?")
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
async function handleRelayFrame(env: Env, rec: FedRecord): Promise<"applied" | "rejected" | "elsewhere"> {
  const us = (ours(env) ?? "").toLowerCase();
  const target = typeof rec.body.target === "string" ? rec.body.target.toLowerCase() : "";
  if (!us || target !== us) return "elsewhere";
  const id = Number(rec.body.id);
  if (!Number.isInteger(id) || id <= 0) return "rejected";

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
    "UPDATE fed_relay_queue SET status='answered', answer=?, answered_at=? WHERE id=? AND instance=? AND status IN ('queued','leased')",
  )
    .bind(JSON.stringify(result), now(), id, rec.origin.toLowerCase())
    .run();
  return res.meta.changes ? "applied" : "rejected";
}

/**
 * The keys a claimed origin's frames may be signed under: the key we last pinned for that peer plus
 * any the signed registry binds to its instance id. `"blocked"` when an operator has quarantined the
 * peer; an empty set when the origin is entirely unknown — either way its frames never apply.
 */
async function originKeys(
  env: Env,
  origin: string,
  registry: Map<string, RegistryEntry>,
  cache: Map<string, string[] | "blocked">,
): Promise<string[] | "blocked"> {
  const hit = cache.get(origin);
  if (hit !== undefined) return hit;
  const row = await env.DB.prepare("SELECT public_key, trust FROM fed_peers WHERE instance = ? AND enabled = 1 LIMIT 1")
    .bind(origin)
    .first<{ public_key: string | null; trust: TrustLevel }>();
  if (row?.trust === "blocked") {
    cache.set(origin, "blocked");
    return "blocked";
  }
  const keys = new Set<string>();
  if (row?.public_key) keys.add(row.public_key);
  const regKey = registry.get(origin)?.key;
  if (regKey) keys.add(regKey);
  const arr = [...keys];
  cache.set(origin, arr);
  return arr;
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
      d.updatedAt ?? null,
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
      d.ts ?? null,
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
export async function handleFederationSync(req: Request, env: Env): Promise<Response> {
  if (!secretOk(req.headers.get("x-ingest-secret"), env.INGEST_SECRET))
    return new Response("unauthorized", { status: 401 });
  const summary = await syncAllPeers(env);
  return json({ ok: true, ...summary });
}

export async function handleFederationPeers(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowIngest: true });
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
 * ingest secret, so the operator's Instance-admin → Federation surface can promote (`trusted`), demote
 * (`unvetted`), or quarantine (`blocked`) a peer. Promotion stamps `approved_at` once.
 */
export async function handlePeerTrust(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowIngest: true });
  if (gate) return gate;
  const b = (await req.json().catch(() => null)) as { url?: string; trust?: string } | null;
  const trust = b?.trust as TrustLevel | undefined;
  if (!b?.url || !trust || !TRUST_LEVELS.includes(trust))
    return json({ ok: false, error: "url + trust (trusted|unvetted|blocked) required" }, { status: 400 });
  const url = b.url.trim().replace(/\/+$/, "");
  const exists = await env.DB.prepare("SELECT url FROM fed_peers WHERE url = ?").bind(url).first<{ url: string }>();
  if (!exists) return json({ ok: false, error: "unknown peer" }, { status: 404 });
  await env.DB.prepare(
    "UPDATE fed_peers SET trust = ?, approved_at = CASE WHEN ? = 'trusted' THEN COALESCE(approved_at, ?) ELSE approved_at END WHERE url = ?",
  )
    .bind(trust, trust, now(), url)
    .run();
  return json({ ok: true, url, trust });
}

// ---- push-to-hub: NAT/firewall peers contribute without inbound reachability ----

/** type → applier, reusing the exact mirror path as pull-sync (display-only, idempotent by global id). */
const APPLIERS: Record<string, (env: Env, rec: FeedRecord, origin: string) => Promise<void>> = Object.fromEntries(
  SYNC_DEFS.map((d) => [d.type, d.apply]),
);

/** The feeds a spoke pushes — tombstones first, matching the sync ordering so a delete suppresses re-mirror. */
const PUSH_FEEDS: FeedServeDef[] = [TOMBSTONE_FEED, CACHE_FEED, FIND_FEED, KEY_FEED];
const PUSH_CURSORS = new Map<string, number>(); // "hub|type" -> last pushed cursor (in-memory; re-push on restart is idempotent)

/**
 * HUB endpoint: accept a spoke's signed records and mirror them as if we had pulled them
 * (push-mode mirroring — same remote_* tables, same display-only semantics). Secret-gated; optionally
 * restricted to an instance allowlist. Each record is verified against the supplied key and MUST name
 * the submitter as its signer, so a spoke can only contribute records as ITSELF — never impersonate
 * another instance. Downstream re-serving of submitted records needs the instance-key registry.
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
  let page: ReturnType<typeof decodeFedSyncPage>;
  try {
    page = decodeFedSyncPage(new Uint8Array(await req.arrayBuffer()));
  } catch {
    return json({ ok: false, error: "not a CBOR sync page" }, { status: 400 });
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
    });
  }
  if (!submitKey) return json({ ok: false, error: "no verifiable frames" }, { status: 400 });
  return submitRecords(env, page.instance, submitKey, records, rejected);
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
): Promise<Response> {
  if (instance === ours(env)) return json({ ok: false, error: "cannot submit as this instance" }, { status: 400 });
  const allow = (env.FED_SUBMIT_INSTANCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length && !allow.includes(instance))
    return json({ ok: false, error: "instance not allowed" }, { status: 403 });

  // a secret-holder must not be able to impersonate a KNOWN instance. If the signed registry
  // binds this instance to a key, the submitted key MUST match it.
  const regEntry = (await loadRegistry(env)).get(instance);
  if (regEntry?.key && regEntry.key !== publicKey)
    return json({ ok: false, error: "submitted key does not match the registry for this instance" }, { status: 403 });
  // TOFU: once we've pinned a key for this submit-instance, it can't silently change (the same
  // no-silent-swap rule as the pull path). A rotated spoke re-registers under a new instance id or the operator clears the row.
  const pinnedRow = await env.DB.prepare("SELECT public_key FROM fed_peers WHERE url = ?")
    .bind(`submit:${instance}`)
    .first<{ public_key: string | null }>();
  if (pinnedRow?.public_key && pinnedRow.public_key !== publicKey)
    return json({ ok: false, error: "submitted key changed for a known instance — refusing" }, { status: 403 });

  // Register the operator-authorised spoke (it holds FED_SUBMIT_SECRET) as a never-pulled peer so its
  // mirrored records carry a uniform trust binding. enabled=0 → never fetched; the synthetic
  // `submit:<instance>` url keeps it out of the pull set. INSERT OR IGNORE respects a later block.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO fed_peers (url, instance, public_key, trust, added_via, approved_at, enabled) VALUES (?, ?, ?, 'trusted', 'submitted', ?, 0)",
  )
    .bind(`submit:${instance}`, instance, publicKey, now())
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
    if (await isTombstoned(env, rec.id)) {
      rejected++;
      continue;
    } // already purged by a tombstone
    await apply(env, rec, instance);
    applied++;
  }
  return json({ ok: true, applied, rejected });
}

/**
 * SPOKE side: push our signed records to a configured hub (push-mode mirroring) when we can't be
 * pulled — a sync page of fedwire frames, the same signed bytes as every other carrier. Incremental
 * via in-memory cursors; idempotent (the hub upserts by global id), so a restart that re-pushes
 * from 0 is harmless. No-op unless FED_HUB_URL + FED_SUBMIT_SECRET + a signing key are present.
 */
export async function pushToHub(env: Env, fetchFn: typeof fetch = fetch): Promise<{ pushed: number } | null> {
  const hub = env.FED_HUB_URL?.replace(/\/+$/, "");
  const secret = env.FED_SUBMIT_SECRET;
  if (!hub || !secret || !env.INSTANCE) return null;
  let pushed = 0;
  for (const def of PUSH_FEEDS) {
    const ckey = `${hub}|${def.type}`;
    let cursor = PUSH_CURSORS.get(ckey) ?? 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const built = await buildFedFrames(env, env.INSTANCE, def.type, cursor, 500);
      if (!built) return null; // no signing key — nothing verifiable to push
      if (!built.frames.length) break;
      const complete = built.frames.length < 500;
      const res = await fetchFn(`${hub}/federation/submit`, {
        method: "POST",
        headers: { "content-type": "application/cbor", "x-fed-secret": secret },
        body: encodeFedSyncPage(env.INSTANCE, built.nextCursor, complete, built.frames) as BodyInit,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { pushed }; // stop; retry next cycle from the same cursor
      PUSH_CURSORS.set(ckey, built.nextCursor);
      pushed += built.frames.length;
      if (complete || built.nextCursor === cursor) break;
      cursor = built.nextCursor;
    }
  }
  return { pushed };
}
