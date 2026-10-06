// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedapply.ts — admitting and applying verified federation records. Every carrier (HTTP pull,
 * push-to-hub, FBB bulletins, HF beacons, connected-mode circuits) hands its signed fedwire frames to
 * {@link admitFrame}, which runs the one set of acceptance checks and the idempotent-by-gid appliers
 * that mirror a record into remote_caches / remote_finds / remote_keys / remote_account_moves /
 * remote_tombstones. Mirrored rows are display-only; the frames behind the caches, finds and tombstones are
 * kept verbatim, so the transit feed can pass them on as their origins signed them (fedtransit.ts).
 */
import type { Env } from "./env.js";
import { b64urlToBytes } from "./util/b64.js";
import { nowS } from "./util/time.js";
import { importVerifyKey, loadRegistry, type RegistryEntry } from "./federation.js";
import { upsertRemoteBulletin } from "./bbs.js";
import { verifyFedFrame, signFedRecord } from "./fedcbor.js";
import { bodyFromWire } from "./fedsync.js";
import { answerRelayQuery, feedSource, parseRelayQuery } from "./relay.js";
import { enqueueAcsfedBulletin } from "./fedforward.js";
import { fedBbsOn } from "./fedbbsgate.js";
import { ours, originKeys } from "./fedpeers.js";
import { mergeEndpoints, storedEndpoints } from "./fedtransport.js";
import { keepForTransit } from "./fedtransit.js";
import {
  accountActionMessage,
  decodeFedFrame,
  decodeFedBbsBatch,
  parseEndpoints,
  type FedRecord,
  type FedRecordKind,
} from "@aprscaching/shared";

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
/**
 * Replay gate: a record applies only if its version is strictly greater than the last one applied
 * for its gid, it was not signed in the future, and — for a timestamp-versioned type — its version is
 * not in the future (a far-future version would freeze the mirror). Equal versions never overwrite,
 * so a replayed or forged record at a version already applied changes nothing.
 */
async function versionAdmits(env: Env, rec: FeedRecord): Promise<boolean> {
  const t = nowS();
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
    .bind(gid, origin, v, nowS())
    .run();
}

/** A peer-supplied timestamp, never later than this clock allows (a far-future value would pin a row). */
function clampFuture(v: unknown): number | null {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : Math.min(n, nowS() + MAX_FUTURE_S);
}

/** Apply one admitted record and remember its version. */
async function applyVersioned(env: Env, def: { apply: SyncDef["apply"] }, rec: FeedRecord, origin: string) {
  await def.apply(env, rec, origin);
  await noteVersion(env, rec.id, origin, rec.cursor);
}

/** Which feed each sync def consumes: its endpoint, advertised capability, peer cursor, and applier. */
export interface SyncDef {
  type: string;
  path: string;
  capability: string;
  cursorCol:
    "caches_cursor" | "finds_cursor" | "keys_cursor" | "tombstones_cursor" | "moves_cursor" | "bulletins_cursor";
  /** The id half of a composite cursor, for feeds whose cursor (a timestamp) can repeat. */
  cursorIdCol?: "caches_cursor_id" | "bulletins_cursor_id";
  apply(env: Env, rec: FeedRecord, origin: string): Promise<void>;
}
export const SYNC_DEFS: SyncDef[] = [
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
 * A federated global id (record id or tombstone target) belongs to exactly one
 * instance — its namespace prefix `<instance>:`. A peer may only serve/overwrite/tombstone ids in
 * ITS OWN namespace; anything else is an impersonation/censorship attempt. Pure + exported for test.
 */
export function idInNamespace(globalId: string | undefined | null, instance: string): boolean {
  return typeof globalId === "string" && globalId.startsWith(instance + ":");
}

/** The record's own origin already tombstoned this global id at this version — don't re-mirror it. Only
 *  the origin that owns a namespace can delete in it, so a tombstone row from any other origin is ignored.
 *  A tombstone with `up_to` (a sysop's removal of a cache) suppresses only the versions up to it, so the
 *  restored cache, at a higher version, mirrors again; without it every version stays suppressed. */
async function isTombstoned(env: Env, globalId: string, origin: string, version: number): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT 1 AS x FROM remote_tombstones WHERE target_id = ? AND origin = ? AND (up_to IS NULL OR ? <= up_to)",
  )
    .bind(globalId, origin, version)
    .first<{ x: number }>());
}

/** A cache its origin lets federate: neither local-only nor imported from another platform. */
function leavesOrigin(d: Record<string, unknown>): boolean {
  return d.fedScope !== "local-only" && (d.source == null || d.source === "native");
}

/**
 * The namespace and self checks every carrier shares, applied to a frame whose signature has already
 * verified. A peer may only serve records IN ITS OWN namespace, self-attested — otherwise it could
 * overwrite another instance's genuine mirror (inheriting its trust).
 */
async function passesNamespaceChecks(env: Env, rec: FeedRecord, instance: string): Promise<boolean> {
  if (!idInNamespace(rec.id, instance)) return false; // id must be in the serving peer's namespace
  if (rec.signer !== instance) return false; // and self-attested as that peer (an empty signer attests nothing)
  if (instance === ours(env)) return false; // never mirror our own
  if (await isTombstoned(env, rec.id, instance, rec.cursor)) return false; // purged by its origin's tombstone
  return true;
}

/**
 * Apply a peer's tombstone: verify-then-purge. Deletes any mirrored cache/find whose global id
 * matches `targetId` (the global-id namespace makes kind unambiguous), and records it so the record
 * is never re-mirrored. PII-free — the tombstone carries only signed ids + a timestamp, and for a
 * sysop's removal of a cache the version it covers (`upTo`, tombstones.ts).
 *
 * Tombstones for one target combine to the widest: one without `upTo` suppresses every version for
 * good, and of two bounded ones the higher bound holds. A copy already mirrored at a version above
 * `upTo` (a restore that arrived first) stays.
 */
async function applyTombstone(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data as { kind?: string; targetId?: string; ts?: number; upTo?: unknown };
  const target = d.targetId;
  if (!target) return;
  // a peer may only tombstone records in ITS OWN namespace. Without this a hostile peer
  // deletes ("censors") any instance's mirrored records network-wide and forges GDPR deletes.
  // `origin` is the verified serving peer (wk.instance), passed by syncFeed.
  if (!idInNamespace(target, origin)) return;
  const upTo = Number.isSafeInteger(d.upTo) && (d.upTo as number) > 0 ? (d.upTo as number) : null;
  const record = env.DB.prepare(
    `INSERT INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at, up_to) VALUES (?,?,?,?,?,?)
     ON CONFLICT(target_id) DO UPDATE SET
       origin = excluded.origin, kind = excluded.kind, ts = excluded.ts, mirrored_at = excluded.mirrored_at,
       up_to = CASE WHEN remote_tombstones.up_to IS NULL OR excluded.up_to IS NULL THEN NULL
                    ELSE MAX(remote_tombstones.up_to, excluded.up_to) END`,
  ).bind(target, origin, d.kind ?? "unknown", d.ts ?? nowS(), nowS(), upTo);
  if (upTo != null) {
    const held = await env.DB.prepare("SELECT v FROM fed_versions WHERE gid = ?").bind(target).first<{ v: number }>();
    if (held && held.v > upTo) {
      await record.run();
      return;
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM remote_caches WHERE global_id = ?").bind(target),
    env.DB.prepare("DELETE FROM remote_finds WHERE global_id = ?").bind(target),
    env.DB.prepare("DELETE FROM remote_keys WHERE global_id = ?").bind(target),
    env.DB.prepare("DELETE FROM remote_account_moves WHERE global_id = ?").bind(target),
    // a mirrored bulletin is stored under its record id, with the peer that served it as its origin
    env.DB.prepare("DELETE FROM bbs_messages WHERE bid = ? AND origin = ?").bind(target, origin),
    // nor is it passed on any more
    env.DB.prepare("DELETE FROM fed_transit WHERE gid = ?").bind(target),
    record,
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
  const ts = Math.min(Number(d.ts) || 0, nowS() + 300);
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
    .bind(cs, d.fromInstance ?? null, d.toInstance, ts, origin, nowS(), rec.id, d.proofAt as number)
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
    return await crypto.subtle.verify("Ed25519", await importVerifyKey(d.proofKey), b64urlToBytes(d.proofSig), msg);
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
    .bind(rec.id, origin, d.callsign ?? null, d.publicKey ?? null, d.verified ? 1 : 0, d.createdAt ?? null, nowS())
    .run();
}

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

/** Who may deliver a frame and what it may carry — the only thing that differs between carriers. */
export interface FrameGate {
  /** The keys a claimed origin's frames verify under; `"blocked"` or none ⇒ the frame is quarantined. */
  keysFor(origin: string): Promise<string[] | "blocked">;
  /** The one origin this delivery speaks for (the pulled or submitting peer); any other is refused. */
  origin?: string;
  /** An origin refused outright: a hub's transit feed never carries the hub's own records. */
  notOrigin?: string;
  /** The one mirror type admitted — a pulled sync page carries a single feed. */
  type?: string;
  /** The mirror types admitted, for a page that mixes them (the transit feed). */
  types?: ReadonlySet<string>;
  /** The instance that delivered the frames, when not their origin (a hub passing records on). */
  via?: string;
  /** Mirror records only: relay and peer-announce frames are refused (push-to-hub). */
  mirrorOnly?: boolean;
}

/** What became of one frame. `ignored` is a valid frame that is not this instance's to act on. */
export type FrameVerdict = "applied" | "rejected" | "quarantined" | "ignored";

/**
 * The single admission path for a signed fedwire frame, whichever carrier delivered it — an HTTP pull,
 * a push-to-hub submission, an FBB bulletin, an HF beacon datagram or a connected-mode circuit page.
 * The claimed origin selects the keys (a forged claim buys nothing: the signature must verify under a
 * key independently bound to that origin); then the signature, the origin, our own namespace, the
 * record's namespace and self-attestation, its origin's tombstones, the cache's scope and the
 * replay/version gate are checked, in that order, before the idempotent-by-gid applier runs. `hops` is how
 * many instances the frame crossed to arrive (1 straight from its origin), kept for passing it on. An applier failure is returned as
 * `error` so a malformed record never aborts the frames after it.
 */
export async function admitFrame(
  env: Env,
  fb: Uint8Array,
  gate: FrameGate,
  hops = 1,
): Promise<{ verdict: FrameVerdict; error?: unknown }> {
  const rejected = { verdict: "rejected" as const };
  let origin: string;
  try {
    origin = decodeFedFrame(fb).record.origin;
  } catch {
    return rejected;
  }
  if (gate.origin !== undefined && origin !== gate.origin) return rejected; // a foreign origin
  if (gate.notOrigin !== undefined && origin === gate.notOrigin) return rejected;
  if (origin === ours(env)) return rejected; // never mirror our own records back in
  const allowed = await gate.keysFor(origin);
  if (allowed === "blocked" || !allowed.length) return { verdict: "quarantined" };
  const f = await verifyFedFrame(fb, allowed);
  if (!f || f.record.origin !== origin) return rejected; // bad signature, key outside the set, origin mismatch
  const kind = f.record.kind;
  if (kind === "relayQuery" || kind === "relayAnswer" || kind === "peer") {
    if (gate.mirrorOnly || gate.type !== undefined || !idInNamespace(f.record.gid, origin)) return rejected;
    if (kind === "peer") return { verdict: (await applyPeerAnnounce(env, f.record, origin)) ? "applied" : "ignored" };
    const r = await handleRelayFrame(env, f.record);
    // "elsewhere": addressed to another instance riding the same flood — not ours to count
    return { verdict: r === "elsewhere" ? "ignored" : r };
  }
  const def = SYNC_DEF_BY_TYPE.get(SYNC_TYPE_BY_KIND[kind] ?? "");
  if (!def || (gate.type !== undefined && def.type !== gate.type)) return rejected;
  if (gate.types !== undefined && !gate.types.has(def.type)) return rejected;
  const rec: FeedRecord = {
    type: def.type,
    id: f.record.gid,
    cursor: f.record.v,
    data: bodyFromWire(f.record.body),
    signer: f.record.signer,
    at: f.record.at,
  };
  // gid outside origin's namespace / not self-attested / tombstoned
  if (!(await passesNamespaceChecks(env, rec, origin))) return rejected;
  // a local-only or imported cache never leaves its origin, whoever passes it on
  if (def.type === "cache" && !leavesOrigin(rec.data)) return rejected;
  // a replay, a record at a version already applied, or future-dated
  if (!(await versionAdmits(env, rec))) return rejected;
  try {
    await applyVersioned(env, def, rec, origin);
    // the mirror holds the record either way; failing to keep it for passing on loses only the onward hop
    await keepForTransit(env, fb, f, rec.data, gate.via ?? origin, hops).catch((e: unknown) =>
      console.warn(`federation: ${rec.id} is mirrored but not kept for passing on: ${(e as Error).message}`),
    );
    return { verdict: "applied" };
  } catch (error) {
    return { verdict: "rejected", error };
  }
}

/** Admit a batch of frames through {@link admitFrame} and count the outcomes. */
export async function applyFrames(env: Env, frames: Uint8Array[], gate: FrameGate): Promise<FedFramesResult> {
  const n = { applied: 0, quarantined: 0, rejected: 0 };
  for (const fb of frames) {
    const { verdict } = await admitFrame(env, fb, gate);
    if (verdict !== "ignored") n[verdict]++;
  }
  return n;
}

/**
 * The trust-gated apply pipeline every non-HTTP carrier feeds — FBB bulletins, HF beacon datagrams,
 * connected-mode circuit pages. Each frame is verified against ITS CLAIMED ORIGIN's keys — the key
 * we last pinned for that peer plus any the signed registry binds to it — then admitted through the
 * same {@link admitFrame} checks as an HTTP pull or a push-to-hub submission, so carriers can never
 * diverge. A frame from an origin the instance does not already know, or one an operator has blocked,
 * is quarantined and never applied: receiving a frame over any carrier introduces no peer and lifts no
 * trust. Apply is idempotent by global id, so frames delivered more than once (multi-path flood,
 * replays) converge.
 */
export async function applyFedFrames(env: Env, frames: Uint8Array[]): Promise<FedFramesResult> {
  let registry: Map<string, RegistryEntry>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return { applied: 0, quarantined: frames.length, rejected: 0 }; // no trustworthy registry → apply nothing
  }
  const keyCache = new Map<string, string[] | "blocked">();
  return applyFrames(env, frames, { keysFor: (origin) => originKeys(env, origin, registry, keyCache) });
}

/**
 * A verified peer-announce (an HF presence beacon) refreshes a KNOWN peer's self-attested endpoint
 * set — addressing only, never a trust input, and strictly an UPDATE: hearing an announce never
 * inserts a peer, so a beacon can't introduce anyone (RX ≠ trust). Endpoints are re-validated
 * through the typed validator so a malformed address never rides an announce in. The announced
 * addresses merge into the stored set (mergeEndpoints): a beacon trimmed to fit one datagram
 * (`partial`) drops nothing, a whole list replaces what the peer said before, and what DNS attested
 * and the row's own address always stay.
 */
async function applyPeerAnnounce(env: Env, rec: FedRecord, origin: string): Promise<boolean> {
  const addresses = parseEndpoints(rec.body.addresses);
  if (!addresses.length) return false;
  const rows = (
    await env.DB.prepare("SELECT url, endpoints FROM fed_peers WHERE instance = ? AND trust != 'blocked'")
      .bind(origin)
      .all<{ url: string; endpoints: string | null }>()
  ).results;
  let changed = false;
  for (const row of rows) {
    const merged = mergeEndpoints(storedEndpoints(row.endpoints), addresses, {
      url: row.url,
      replace: rec.body.partial !== true,
    });
    const res = await env.DB.prepare(
      "UPDATE fed_peers SET endpoints = ?, endpoints_source = COALESCE(endpoints_source, 'announce') WHERE url = ?",
    )
      .bind(JSON.stringify(merged), row.url)
      .run();
    changed ||= !!res.meta.changes;
  }
  return changed;
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
  const t = nowS();
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
    // the answer goes back over FBB, which carries nothing while FED_BBS is off
    if (!fedBbsOn(env)) return "rejected";
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
    const at = nowS();
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
    .bind(JSON.stringify(result), nowS(), id, rec.origin.toLowerCase())
    .run();
  return res.meta.changes ? "applied" : "rejected";
}

export async function upsertRemoteCache(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
  // version-monotonic — a replayed OLDER signed record (stale cursor, hostile replay)
  // must never roll a mirror back, e.g. to pre-redaction content. Only a record at least as new
  // (by the origin's own updated_at) may overwrite.
  await env.DB.prepare(
    `INSERT INTO remote_caches
       (global_id, origin, code, owner_call, title, type, status, difficulty, terrain, lat, lon,
        station_call, source, external_id, hint, description, min_trust, fed_scope, created_at, updated_at, mirrored_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(global_id) DO UPDATE SET
       origin=excluded.origin, code=excluded.code, owner_call=excluded.owner_call,
       title=excluded.title, type=excluded.type, status=excluded.status,
       difficulty=excluded.difficulty, terrain=excluded.terrain, lat=excluded.lat, lon=excluded.lon,
       station_call=excluded.station_call, source=excluded.source, external_id=excluded.external_id,
       hint=excluded.hint, description=excluded.description, min_trust=excluded.min_trust, fed_scope=excluded.fed_scope,
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
      d.fedScope === "unlisted" ? "unlisted" : "public",
      d.createdAt ?? null,
      clampFuture(d.updatedAt),
      nowS(),
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
      nowS(),
    )
    .run();
}
