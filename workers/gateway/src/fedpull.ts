// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedpull.ts — the consumer side of federation. Pull peers' CBOR sync pages, verify each frame under
 * the key set pinned for its origin (checked against the peer's descriptor, the signed registry and its
 * rotation records), and hand every frame to the shared admission path (fedapply.ts). Caches, finds,
 * tombstones and account moves are pulled per origin, from the marks of what this instance holds
 * (fedtransit.ts); keys and bulletins per peer, from its cursors. One pull per peer runs at a time.
 *
 * Runtime-neutral (fetch + crypto.subtle + env.DB) → runs on Node and Bun alike. This
 * instance never mirrors itself.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { nowS } from "./util/time.js";
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import {
  FED_PROTOCOL_VERSION,
  ORIGIN_SYNC_CAPABILITY,
  type FedPublicKey,
  isInstanceId,
  keyFingerprint,
  loadRegistry,
  parseAcceptKeys,
  registryKeyAllowed,
  resolvePeerKeys,
  usableKeys,
  type RegistryEntry,
  type RotationRecord,
} from "./federation.js";
import { mergeEndpoints, storedEndpoints, syncTransportFor, type FedSyncTransport } from "./fedtransport.js";
import { decodeFedSyncPage } from "./fedsync.js";
import { decodeFedFrame, parseEndpoints } from "@aprscaching/shared";
import {
  type PeerRow,
  absorbDiscovered,
  blockedAt,
  ours,
  originKeys,
  seedPeers,
  listEnabledPeers,
} from "./fedpeers.js";
import { learnFromPeer } from "./feddiscover.js";
import { SYNC_DEFS, type FrameGate, admitFrame } from "./fedapply.js";
import { bboxKey, parseBbox, SYNC_REGION_CAPABILITY } from "./fedregion.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import {
  heldKeys,
  hopGap,
  learnTransitKeys,
  markGen,
  markOf,
  raiseOwnSequences,
  readPosOf,
  rotationsJson,
  setMark,
  setReadPos,
  supersedeTransitPeer,
  MAX_TRANSIT_HOPS,
  ORIGIN_KINDS,
  type OriginKind,
  type SummaryEntry,
} from "./fedtransit.js";

/** Most pages one pass reads (pull) or sends (push) per feed. */
export const MAX_PAGES = 50;

/** Largest pull page the consumer reads, and the most frames it accepts per requested page. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_LIMIT = 500;

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
  /** Records peers passed on from other origins. */
  transit: number;
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
    bulletins = 0,
    transit = 0;
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
      transit += r.transit;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${p.url}: ${msg}`);
      await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=?, sync_err = sync_err + 1 WHERE url=?")
        .bind(msg, nowS(), p.url)
        .run();
    }
  }
  return { peers: peers.length, bytes, caches, finds, keys, tombstones, moves, bulletins, transit, errors };
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
  transit: number;
}> {
  // endpoint selection: the peer's typed endpoint set picks the sync transport (https, a 44Net name over
  // https or plain http, a HAMNET host); packet endpoints are forward-mode and never pulled from here
  const transport = syncTransportFor(p, (u, i) => fedFetch(env, u, i));
  if (!transport) throw new Error("peer has no sync-capable endpoint");
  const wk = await transport.fetchJson<{
    instance: string;
    signed: boolean;
    publicKey: string | null;
    publicKeys?: FedPublicKey[];
    rotations?: RotationRecord[];
    capabilities?: string[];
    protocolVersions?: string[];
    addresses?: unknown;
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
    return { bytes: 0, caches: 0, finds: 0, keys: 0, tombstones: 0, moves: 0, bulletins: 0, transit: 0 };
  // a row only discovery brought gives way to this one (feddiscover.ts)
  await absorbDiscovered(env, wk.instance, p.url);
  // one live row per instance id: a second URL claiming a bound instance is an impostor or a stale
  // address, and the operator decides which (block or remove the other peer in Instance admin)
  // (a key a hub handed on gives way to the peer's own, below)
  const holder = await env.DB.prepare(
    "SELECT url FROM fed_peers WHERE instance = ? AND url != ? AND trust != 'blocked' AND COALESCE(added_via, '') != 'transit'",
  )
    .bind(wk.instance, p.url)
    .first<{ url: string }>();
  if (holder) throw new Error(`instance ${wk.instance} is already bound to ${holder.url} — refusing`);
  // a block covers the instance under every address: a new address for it is not a way back in
  const blocked = await blockedAt(env, wk.instance, p.url);
  if (blocked) throw new Error(`instance ${wk.instance} is blocked here (at ${blocked}) — refusing`);

  // anti-spoof: if a signed registry binds this instance to a key, the peer's CURRENT key must be
  // that key. Unregistered peers fall back to trust-on-first-use.
  const registry = await loadRegistry(env);
  const registryEntry = registry.get(wk.instance);
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
  // A FED_PEERS entry that pins a fingerprint names the key its sysop compared: the peer's keys must
  // include it, or this is not that peer. Once a key matched, the row's pin moves on from it only along
  // the verified rotation chain (resolvePeerKeys), so the pin keeps holding after the matched key's grace.
  const pinnedFp = p.pinned_fingerprint ?? null;
  let pinMatches = false;
  let matchedKey = p.pin_matched_key ?? null;
  if (pinnedFp) {
    const anchored = !!matchedKey && !!p.public_key && (await keyFingerprint(matchedKey)) === pinnedFp;
    if (anchored) pinMatches = true;
    else {
      const held = [keys.pin, p.public_key, ...usableKeys(keys.accept, nowS())].filter((k): k is string => !!k);
      matchedKey = null;
      for (const k of new Set(held)) if ((await keyFingerprint(k)) === pinnedFp) matchedKey ??= k;
      if (!matchedKey)
        throw new Error(`peer ${wk.instance}: its key does not match the fingerprint pinned in FED_PEERS — refusing`);
      pinMatches = !!keys.pin && (await keyFingerprint(keys.pin)) === pinnedFp;
    }
  }
  // Identity and keys check out: the addresses the peer's descriptor lists join its endpoint set, unless DNS
  // set it (a peer added by callsign), which the peer's own word never replaces.
  const learnEndpoints = p.endpoints_source !== "dns";
  const endpoints = learnEndpoints
    ? mergeEndpoints(storedEndpoints(p.endpoints), parseEndpoints(wk.addresses), { url: p.url, replace: true })
    : [];
  const acceptJson = JSON.stringify(keys.accept);
  // the peer's own keys replace any a hub handed on for it
  await supersedeTransitPeer(env, wk.instance, heldKeys(keys.pin, keys.accept));
  try {
    await env.DB.prepare(
      `UPDATE fed_peers SET instance=?, public_key=?, accept_keys=?, pin_matched_key=?, rotations=?,
         endpoints        = CASE WHEN ? THEN ? ELSE endpoints END,
         endpoints_source = CASE WHEN ? THEN ? ELSE endpoints_source END
       WHERE url=?`,
    )
      .bind(
        wk.instance,
        keys.pin,
        acceptJson,
        matchedKey,
        rotationsJson(wk.rotations),
        learnEndpoints ? 1 : 0,
        endpoints.length ? JSON.stringify(endpoints) : null,
        learnEndpoints ? 1 : 0,
        endpoints.length ? "descriptor" : null,
        p.url,
      )
      .run();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message))
      throw new Error(`instance ${wk.instance} is already bound to another peer — refusing`, { cause: e });
    throw e;
  }
  // the key matches the fingerprint the sysop pinned: the peer starts trusted, once — a level the
  // operator set since (approved_at stamped, or blocked) is never overridden
  if (pinMatches && p.trust === "unvetted" && p.approved_at == null) {
    const r = await env.DB.prepare(
      "UPDATE fed_peers SET trust = 'trusted', approved_at = ? WHERE url = ? AND trust = 'unvetted' AND approved_at IS NULL",
    )
      .bind(nowS(), p.url)
      .run();
    if (r.meta.changes) p.trust = "trusted";
  }
  const newActive = usableKeys(keys.accept, nowS());

  // peer exchange: the instances a trusted peer trusts, listed here switched off (feddiscover.ts)
  await learnFromPeer(env, transport, p, wk);

  // capability negotiation: a peer that speaks our protocol version has an authoritative
  // capability list → skip feeds it doesn't advertise; otherwise every known feed is tried and a 404
  // is treated as "not supported". The CBOR sync surface is the only mirror wire — a peer without it (or
  // unsigned) simply has nothing verifiable to mirror, and its feeds are skipped via the same 404 contract.
  const caps = wk.capabilities ?? [];
  const toSync = new Set(negotiateFeeds(wk, SYNC_DEFS, FED_PROTOCOL_VERSION).map((d) => d.type));
  const wanted = opts.types ? new Set([...opts.types, "tombstone"]) : null;
  const want = (type: string) => toSync.has(type) && (!wanted || wanted.has(type));
  // The caches narrow to FED_SYNC_REGION where the publisher filters by region; elsewhere they travel whole.
  const region = parseBbox(env.FED_SYNC_REGION);
  if (env.FED_SYNC_REGION && !region)
    console.warn("federation: FED_SYNC_REGION is not S,W,N,E in decimal degrees; pulling every cache");
  const maxPages = Math.min(Math.max(1, opts.maxPages ?? MAX_PAGES), MAX_PAGES);
  const ctx: PullContext = {
    env,
    transport,
    neighbour: wk.instance,
    trusted: p.trust === "trusted",
    activeKeys: newActive,
    registry,
    keyCache: new Map(),
    region: region && caps.includes(SYNC_REGION_CAPABILITY) ? bboxKey(region) : "",
    maxPages,
    relayed: { pages: maxPages },
    bytes: 0,
  };
  // what the peer holds, per origin: its own records, and those of the origins it passes on, whose keys it hands on
  const origins = await summaryOf(ctx, caps.includes(ORIGIN_SYNC_CAPABILITY));
  await learnTransitKeys(env, wk.instance, origins, registry);
  const counts: Record<string, number> = { transit: 0 };
  const byOrigin = async (kinds: OriginKind[]) => {
    for (const e of origins)
      for (const kind of kinds) {
        if (!want(kind)) continue;
        const n = await pullOrigin(ctx, e, kind);
        if (e.origin === wk.instance) counts[kind] = (counts[kind] ?? 0) + n;
        else counts.transit! += n;
      }
  };
  // deletes first, from every origin, so no stale copy outruns its tombstone in this pass; keys before the
  // account moves, whose proofs verify under them
  await byOrigin(["tombstone"]);
  counts.key = want("key") ? await pullFeed(ctx, p, "key") : 0;
  await byOrigin(["account-move", "cache", "find"]);
  counts.bulletin = want("bulletin") ? await pullFeed(ctx, p, "bulletin") : 0;
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
    bytes: ctx.bytes,
    caches: counts.cache ?? 0,
    finds: counts.find ?? 0,
    keys: counts.key ?? 0,
    tombstones: counts.tombstone ?? 0,
    moves: counts["account-move"] ?? 0,
    bulletins: counts.bulletin ?? 0,
    transit: counts.transit ?? 0,
  };
}

/**
 * Capability negotiation (pure/testable): which of our feed defs to pull from a peer. A peer that
 * advertises our protocol version has an authoritative capability list → pull only the feeds it offers;
 * a peer that does not advertise our protocol version is tried for every known feed (a 404 is handled gracefully
 * by the pull). Order is preserved.
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

/** One peer's pull: the peer, the keys its own frames verify under, the caches region and the page budgets. */
interface PullContext {
  env: Env;
  transport: FedSyncTransport;
  /** The peer being pulled. */
  neighbour: string;
  /** This instance trusts the peer: its pages of other origins move the marks. */
  trusted: boolean;
  activeKeys: string[];
  registry: Map<string, RegistryEntry>;
  keyCache: Map<string, string[] | "blocked">;
  /** The caches region ('' = whole). */
  region: string;
  /** Pages per feed, and per kind of the peer's own records. */
  maxPages: number;
  /** Pages left for the records it passes on from other origins, shared by all of them. */
  relayed: { pages: number };
  /** Bytes of sync pages read. */
  bytes: number;
}

/** Summary pages one pull reads, and the largest one it accepts. */
const MAX_SUMMARY_PAGES = 20;
const MAX_SUMMARY_BYTES = 1024 * 1024;

const seqOf = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/**
 * The peer's summary: the origins it serves, its own first. Without one (a peer that serves none, or an error)
 * the peer's own records are still pulled, from this instance's marks. Where the peer says how far it holds this
 * instance's own records, this instance's sequences rise to at least that (raiseOwnSequences).
 */
async function summaryOf(ctx: PullContext, served: boolean): Promise<SummaryEntry[]> {
  const out: SummaryEntry[] = [];
  const us = ours(ctx.env);
  let after = "";
  for (let i = 0; served && i < MAX_SUMMARY_PAGES; i++) {
    const q = [
      us ? `for=${encodeURIComponent(us)}` : "",
      ctx.region ? `bbox=${ctx.region}` : "",
      after ? `after=${encodeURIComponent(after)}` : "",
    ]
      .filter(Boolean)
      .join("&");
    const res = await ctx.transport.get(`/federation/sync/summary?${q}`);
    if (!res.ok) break; // what was read stands; the peer's own records come regardless
    const body = await readCappedBody(res, MAX_SUMMARY_BYTES);
    let page: { origins?: unknown; complete?: unknown; next?: unknown; asker?: { held?: unknown } };
    try {
      page = body ? (JSON.parse(new TextDecoder().decode(body)) as typeof page) : {};
    } catch {
      break;
    }
    if (i === 0 && page.asker?.held && typeof page.asker.held === "object") {
      const mine: SummaryEntry["held"] = {};
      for (const kind of ORIGIN_KINDS) {
        const v = seqOf((page.asker.held as Record<string, unknown>)[kind]);
        if (v !== undefined) mine[kind] = v;
      }
      await raiseOwnSequences(ctx.env, mine);
    }
    for (const raw of Array.isArray(page.origins) ? page.origins : []) {
      const e = raw as Partial<SummaryEntry> | null;
      if (!e || !isInstanceId(e.origin) || out.some((o) => o.origin === e.origin)) continue;
      // a kind the summary leaves out is one the peer holds none of, whole or at all
      const held: SummaryEntry["held"] = {};
      const top: SummaryEntry["top"] = {};
      for (const kind of ORIGIN_KINDS) {
        held[kind] = seqOf((e.held as Record<string, unknown> | undefined)?.[kind]) ?? 0;
        top[kind] = Math.max(seqOf((e.top as Record<string, unknown> | undefined)?.[kind]) ?? 0, held[kind]);
      }
      out.push({ ...e, origin: e.origin, held, top });
    }
    if (page.complete !== false || typeof page.next !== "string" || page.next <= after) break;
    after = page.next;
  }
  const own = out.find((e) => e.origin === ctx.neighbour);
  // a peer that did not list itself is asked for its own records regardless: no `held` or `top` means "ask"
  return [own ?? { origin: ctx.neighbour, held: {}, top: {} }, ...out.filter((e) => e !== own)];
}

/** The sequence a frame claims, before any check: where a page stops being held when that frame did not settle. */
function claimedSeq(fb: Uint8Array): number {
  try {
    return decodeFedFrame(fb).record.v;
  } catch {
    return 0;
  }
}

/**
 * Pull one origin's records of one kind from the peer: "origin after N". Every frame verifies under ITS ORIGIN's
 * keys — the peer's own when the peer is the origin, otherwise the peer row this instance holds for the origin,
 * the key a neighbour handed on (`transit:` rows, learnTransitKeys) or the registry's binding — and lands under
 * that origin, with this instance's trust in it: an origin unknown or blocked here is not asked for.
 *
 * Two positions. The mark says how far this instance holds the origin, whichever path brought it; the read
 * position how far it has read this peer's pages of it. A peer whose word moves the mark (the origin itself, or a
 * peer this instance trusts) and that holds the origin whole past the mark is asked from the mark, so it fills a
 * gap below what was read; otherwise the peer is asked only past both, and only when it has records there.
 *
 * The mark moves to the page's `min(held, nextCursor)`, never past the first frame that did not settle (a
 * temporary refusal) nor past a record this instance keeps but may not pass on (the hop limit), which another
 * neighbour then fills.
 */
async function pullOrigin(ctx: PullContext, e: SummaryEntry, kind: OriginKind): Promise<number> {
  const { env } = ctx;
  const us = ours(env);
  if (e.origin === us) return 0;
  const own = e.origin === ctx.neighbour;
  let keys = ctx.activeKeys;
  if (!own) {
    const k = await originKeys(env, e.origin, ctx.registry, ctx.keyCache);
    if (k === "blocked" || !k.length) return 0;
    keys = k;
  }
  const region = kind === "cache" ? ctx.region : "";
  const gen = await markGen(env, e.origin);
  let mark = await markOf(env, e.origin, kind, region);
  const read = await readPosOf(env, ctx.neighbour, e.origin, kind, region);
  const advances = own || ctx.trusted;
  const held = e.held[kind];
  const top = e.top[kind];
  let cursor: number;
  if (held === undefined && top === undefined) cursor = advances ? mark : Math.max(mark, read);
  else if (advances && (held ?? 0) > mark) cursor = mark;
  else if ((top ?? 0) > Math.max(mark, read)) cursor = Math.max(mark, read);
  else return 0; // nothing new there
  const budget = own ? { pages: ctx.maxPages } : ctx.relayed;
  const gate: FrameGate = {
    origin: e.origin,
    type: kind,
    keysFor: () => Promise.resolve(keys),
    ...(!own && { mirrorOnly: true, via: ctx.neighbour }),
  };
  const path = `/federation/sync/origin?origin=${encodeURIComponent(e.origin)}&kind=${kind}`;
  const query = `${region ? `&bbox=${region}` : ""}${us ? `&for=${encodeURIComponent(us)}` : ""}&limit=${PAGE_LIMIT}`;
  let applied = 0;
  while (budget.pages > 0) {
    budget.pages--;
    const res = await ctx.transport.get(`${path}&since=${cursor}${query}`);
    if (res.status === 404) break; // not served there
    if (res.status === 429) {
      budget.pages = 0; // the peer asks for a pause: the rest waits for the next pass
      break;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${path}`);
    const body = await readCappedBody(res, MAX_PAGE_BYTES);
    if (!body) throw new Error(`${path} page too large (over ${MAX_PAGE_BYTES} bytes)`);
    ctx.bytes += body.byteLength;
    const pg = decodeFedSyncPage(body);
    if (pg.frames.length > PAGE_LIMIT)
      throw new Error(`${path} page has ${pg.frames.length} frames (asked for ${PAGE_LIMIT})`);
    let unsettled: number | null = null;
    for (const [i, fb] of pg.frames.entries()) {
      // each frame stands alone: a malformed or unappliable record is skipped, never a reason to replay the page
      const skipped = (err: unknown) =>
        console.warn(
          `federation: skipped a ${kind} record of ${e.origin} from ${ctx.neighbour}: ${(err as Error).message}`,
        );
      // a frame without its hop count is taken as having travelled as far as a record may
      const hops = (pg.hops?.[i] ?? MAX_TRANSIT_HOPS) + 1;
      let settled = false;
      try {
        const r = await admitFrame(env, fb, gate, hops);
        if (r.verdict === "applied") applied++;
        else if (r.error) skipped(r.error);
        settled = r.settled === true;
      } catch (err) {
        skipped(err);
      }
      if (!settled) unsettled = Math.min(unsettled ?? Infinity, claimedSeq(fb));
    }
    const next = pg.nextCursor;
    if (advances && pg.held !== undefined) {
      let upTo = Math.min(pg.held, next);
      if (unsettled !== null) upTo = Math.min(upTo, unsettled - 1);
      const gap = await hopGap(env, e.origin, kind, mark);
      if (gap !== null) upTo = Math.min(upTo, gap - 1);
      if (upTo > mark) {
        await setMark(env, e.origin, kind, upTo, gen, region);
        mark = upTo;
      }
    }
    await setReadPos(env, ctx.neighbour, e.origin, kind, region, next, gen);
    if (pg.complete || next <= cursor) break;
    cursor = next;
  }
  return applied;
}

/**
 * Pull one of a peer's per-peer feeds (keys, bulletins): CBOR sync pages of frames the peer signed, verified
 * under its active keys, applied, and the peer cursor advanced. The origin is ALWAYS the verified serving peer
 * (wk.instance), never anything the payload claims, and a page carries only its own feed's type. A 404 means the
 * peer doesn't serve this feed → skip it, never failing the whole sync.
 */
async function pullFeed(ctx: PullContext, p: PeerRow, type: "key" | "bulletin"): Promise<number> {
  const { env } = ctx;
  const def = SYNC_DEFS.find((d) => d.type === type)!;
  const cursorCol = def.cursorCol!;
  let cursor = p[cursorCol] ?? 0,
    cursorId = def.cursorIdCol ? (p[def.cursorIdCol] ?? null) : null,
    applied = 0;
  const gate: FrameGate = { origin: ctx.neighbour, type: def.type, keysFor: () => Promise.resolve(ctx.activeKeys) };
  for (let page = 0; page < ctx.maxPages; page++) {
    const idParam = cursorId != null ? `&sinceId=${cursorId}` : "";
    const res = await ctx.transport.get(`/federation/sync/${def.type}?since=${cursor}${idParam}&limit=${PAGE_LIMIT}`);
    if (res.status === 404) return applied; // feed not served here → forward-compat skip
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- /federation/sync/${def.type}`);
    const body = await readCappedBody(res, MAX_PAGE_BYTES);
    if (!body) throw new Error(`/federation/sync/${def.type} page too large (over ${MAX_PAGE_BYTES} bytes)`);
    ctx.bytes += body.byteLength;
    const pg = decodeFedSyncPage(body);
    if (pg.frames.length > PAGE_LIMIT)
      throw new Error(`/federation/sync/${def.type} page has ${pg.frames.length} frames (asked for ${PAGE_LIMIT})`);
    for (const fb of pg.frames) {
      // each frame stands alone: a malformed or unappliable record is skipped, never a reason to
      // hold the cursor and replay the page forever
      const skipped = (e: unknown) =>
        console.warn(`federation: skipped a ${def.type} record from ${ctx.neighbour}: ${(e as Error).message}`);
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
      await env.DB.prepare(`UPDATE fed_peers SET ${cursorCol}=?, ${def.cursorIdCol}=? WHERE url=?`)
        .bind(next, nextId, p.url)
        .run();
    else await env.DB.prepare(`UPDATE fed_peers SET ${cursorCol}=? WHERE url=?`).bind(next, p.url).run();
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

/** Per-peer Sync now: at most this many pulls of one peer per window, whoever asks. */
const PEER_SYNC_MAX = 3;
const PEER_SYNC_WINDOW_MS = 60_000;

/**
 * POST /federation/peers/sync — Sync now for one peer, body `{ url }`. Sysop or the operator secret, rate
 * limited per peer. It pulls at once (sharing a pull already running for the peer) and answers with what the
 * pull brought, or its error, and the peer's last pull times. A disabled or blocked peer is never contacted.
 */
export async function handlePeerSyncNow(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const b = (await req.json().catch(() => null)) as { url?: unknown } | null;
  if (typeof b?.url !== "string" || !b.url.trim()) return json({ ok: false, error: "url required" }, { status: 400 });
  const url = trimTrailingSlashes(b.url.trim());
  const p = await env.DB.prepare("SELECT * FROM fed_peers WHERE url = ?").bind(url).first<PeerRow>();
  if (!p) return json({ ok: false, error: "unknown peer" }, { status: 404 });
  if (p.trust === "blocked")
    return json({ ok: false, error: "this peer is blocked: it is never contacted" }, { status: 409 });
  if (!p.enabled)
    return json({ ok: false, error: "this peer is not enabled: choose a trust level for it first" }, { status: 409 });
  if (await rateLimitedDurable(env, `peer-sync:${url}`, Date.now(), PEER_SYNC_MAX, PEER_SYNC_WINDOW_MS))
    return json({ ok: false, error: "this peer was just pulled: try again in a minute" }, { status: 429 });
  let pulled: PeerSyncCounts | null = null;
  let error: string | null = null;
  try {
    pulled = await syncPeerCoalesced(env, p);
  } catch (e) {
    error = (e as Error).message;
    await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=?, sync_err = sync_err + 1 WHERE url=?")
      .bind(error, nowS(), url)
      .run();
  }
  const row = await env.DB.prepare("SELECT last_sync, last_ok, last_error FROM fed_peers WHERE url = ?")
    .bind(url)
    .first<{ last_sync: number | null; last_ok: number | null; last_error: string | null }>();
  return json({
    ok: !error,
    url,
    ...(pulled && { pulled }),
    ...(error && { error }),
    lastSync: row?.last_sync ?? null,
    lastOk: row?.last_ok ?? null,
    lastError: row?.last_error ?? null,
  });
}
