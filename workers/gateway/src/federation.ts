// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * federation.ts — read-only, mirrorable, signed feeds.
 *
 * An instance publishes its caches and find logs so peers can mirror them and build a global
 * catalog. Records are Ed25519-signed by the instance (WebCrypto — same code on
 * Node and Bun) so a mirror can verify provenance + integrity. The envelope is
 * shaped so per-callsign signing slots in without a format change (signer becomes a callsign, not the instance).
 *
 *   GET /.well-known/aprscaching        instance descriptor + public key + addresses
 *   GET /federation/caches?since=<rev>  cache records (cursor = the caches sequence, fed_rev)
 *   GET /federation/finds?since=<seq>   find records  (cursor = the finds sequence, fed_seq)
 *
 * Cursors are high-water marks of a sequence that only this instance assigns, so a mirror can say "I hold
 * this origin's caches up to N" whichever path brought them (fedtransit.ts). Records are idempotent by `id`.
 */
import { b64urlToBytes } from "./util/b64.js";
import { nowS } from "./util/time.js";
import { fedFetch, trimTrailingSlashes } from "./fetchguard.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { displayCall } from "./auth.js";
import { verificationsOf } from "./callsign.js";
import { baseCall } from "@aprscaching/aprs";
import { parseEndpoints, SIG_DOMAIN, type FedEndpoint } from "@aprscaching/shared";
import { bboxWhere, SYNC_REGION_CAPABILITY, type Bbox } from "./fedregion.js";
import { serviceCall } from "./servicecall.js";
import { PEER_EXCHANGE_CAPABILITY, PEER_EXCHANGE_PATH, peerExchangeOn } from "./feddiscover.js";

const PROTOCOL = "aprscaching-federation/0.1";
/** Wire protocol versions this instance speaks. 0.2 adds the generalized envelope + negotiation. */
export const FED_PROTOCOL_VERSION = "0.2";
const PROTOCOL_VERSIONS = ["0.1", "0.2"];
/** The descriptor capability of an instance serving the per-origin summary and pages (fedtransit.ts). */
export const ORIGIN_SYNC_CAPABILITY = "sync-origins";

// ---- database row shapes (subset) ----
interface CacheRow {
  id: number;
  fed_id: number;
  code: string;
  owner_call: string;
  title: string;
  type: string;
  status: string;
  difficulty: number;
  terrain: number;
  lat: number | null;
  lon: number | null;
  station_call: string | null;
  source: string;
  external_id: string | null;
  hint: string | null;
  description: string | null;
  min_trust: string | null;
  fed_scope: string;
  created_at: number;
  updated_at: number;
  fed_rev?: number;
}
interface FindRow {
  id: number;
  fed_seq: number;
  cache_id: number;
  cache_fed_id: number;
  cache_code: string | null;
  logger_call: string;
  ts: number;
  log_type: string;
  verified: number;
  tier: string | null;
  verify_method: string | null;
  distance_m: number | null;
  comment: string | null;
  signer_key: string | null;
  author_sig: string | null;
  signed_at: number | null;
}
interface KeyRow {
  id: number;
  callsign: string;
  public_key: string;
  created_at: number;
  /** Whether the key's call is control-verified, from the verification store when the page is served. */
  verified: boolean;
}

function cacheData(r: CacheRow) {
  // Redaction: the hint is a spoiler and NEVER federates; an `unlisted` cache withholds its
  // description too (location/title only). `local-only` caches are filtered out before this (CACHE_FEED).
  return {
    code: r.code,
    ownerCall: displayCall(r.owner_call),
    title: r.title,
    type: r.type,
    status: r.status,
    difficulty: r.difficulty,
    terrain: r.terrain,
    lat: r.lat,
    lon: r.lon,
    stationCall: r.station_call,
    source: r.source,
    externalId: r.external_id,
    description: r.fed_scope === "unlisted" ? null : r.description,
    minTrust: r.min_trust,
    fedScope: r.fed_scope,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function findData(r: FindRow, instance: string) {
  return {
    cacheId: `${instance}:cache:${r.cache_fed_id}`,
    cacheCode: r.cache_code,
    loggerCall: displayCall(r.logger_call),
    ts: r.ts,
    logType: r.log_type,
    verified: r.verified === 1,
    tier: r.tier,
    verifyMethod: r.verify_method,
    distanceM: r.distance_m,
    comment: r.comment,
    // per-callsign authorship signature: self-contained, verifiable by anyone
    authorKey: r.signer_key,
    authorSig: r.author_sig,
    signedAt: r.signed_at,
  };
}
function keyData(r: KeyRow) {
  return { callsign: r.callsign, publicKey: r.public_key, verified: r.verified, createdAt: r.created_at };
}

// ---- canonical JSON + Ed25519 (WebCrypto) ----
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

interface FedKey {
  key: CryptoKey;
  publicX: string;
  jwk: { kty: string; crv: string; x: string };
}
// Imported keys by their FED_PRIVATE_KEY value, so a key changed in config takes effect without a
// restart and instances sharing one process (tests, a multi-instance host) each sign with their own.
const keyCache = new Map<string, Promise<FedKey | null>>();
/**
 * FED_PRIVATE_KEY is base64(JSON({ pkcs8, pub })) — see tools/fedkey/genkey.mjs. We import the
 * private key as PKCS8 (supported on both Node and Bun; the Ed25519 *private JWK* import is
 * not portable) and publish the raw public key (base64url) for consumers to verify.
 */
export function loadKey(env: Env): Promise<FedKey | null> {
  const cacheKey = env.FED_PRIVATE_KEY ?? "";
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const p: Promise<FedKey | null> = (async () => {
    if (!env.FED_PRIVATE_KEY) return null; // legitimately unconfigured → a cacheable null
    const { pkcs8, pub } = JSON.parse(new TextDecoder().decode(b64urlToBytes(env.FED_PRIVATE_KEY)));
    const key = await crypto.subtle.importKey("pkcs8", b64urlToBytes(pkcs8), { name: "Ed25519" }, false, ["sign"]);
    return { key, publicX: pub, jwk: { kty: "OKP", crv: "Ed25519", x: pub } };
  })().catch((e) => {
    // A configured key that fails to import is a TRANSIENT error — memoizing it as null
    // would make the instance silently serve unsigned feeds for its whole life. Log it and clear the
    // cache so the next call retries instead of sticking on the failure.
    console.error("federation signing key load failed (will retry):", (e as Error).message);
    if (keyCache.get(cacheKey) === p) keyCache.delete(cacheKey);
    return null;
  });
  keyCache.set(cacheKey, p);
  return p;
}
/**
 * A federation key's fingerprint, for two sysops to compare out of band (by phone, on the air, in person): the
 * first 64 bits of SHA-256 over the raw Ed25519 key, as four groups of four hex digits (`3f2a 9c01 bb7e 4d10`).
 * Null for a missing or malformed key. `deploy/lib/doctor.sh` prints the same value.
 */
export async function keyFingerprint(rawB64url: string | null | undefined): Promise<string | null> {
  if (!rawB64url) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(b64urlToBytes(rawB64url));
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)!.join(" ");
}

/** This instance's own federation key fingerprint, or null when it signs nothing (no FED_PRIVATE_KEY). */
export async function ownKeyFingerprint(env: Env): Promise<string | null> {
  return keyFingerprint((await loadKey(env))?.publicX);
}

/**
 * Sign arbitrary bytes with the instance key — the CBOR wire format (fedcbor.ts) builds its
 * domain-separated signing bytes itself and only needs the raw Ed25519 primitive + the public key.
 */
export async function signRaw(
  env: Env,
  msg: Uint8Array<ArrayBuffer>,
): Promise<{ sig: Uint8Array<ArrayBuffer>; publicX: string } | null> {
  const fk = await loadKey(env);
  if (!fk) return null;
  return { sig: new Uint8Array(await crypto.subtle.sign("Ed25519", fk.key, msg)), publicX: fk.publicX };
}

// ---- key rotation + multi-key + revocation ----
export interface FedPublicKey {
  x: string;
  since?: number;
  until?: number;
  revoked?: boolean;
}
export interface RotationRecord {
  key: string;
  prevKey: string;
  at: number;
  sig: string;
}

function parseJsonArray<T>(s: string | undefined): T[] {
  try {
    const a = JSON.parse(s ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** This instance's published key set: the current signing key + any history/revocations from config. */
async function instanceKeys(env: Env): Promise<FedPublicKey[]> {
  const fk = await loadKey(env);
  const history = parseJsonArray<FedPublicKey>(env.FED_KEY_HISTORY).filter((k) => k && k.x && k.x !== fk?.publicX);
  return [...(fk ? [{ x: fk.publicX } as FedPublicKey] : []), ...history];
}

/** Pure: the non-revoked, in-window key strings from a published key list — the accept set. */
export function activeFedKeys(keys: FedPublicKey[], nowS: number): string[] {
  return keys
    .filter(
      (k) => k && k.x && !k.revoked && (k.since == null || k.since <= nowS) && (k.until == null || k.until > nowS),
    )
    .map((k) => k.x);
}

/**
 * An instance id is a lowercase hostname: dot-separated labels of letters, digits and inner
 * hyphens, never a `:`. Global ids are namespaced `<instance>:…`, so an id containing a colon could
 * claim a slice of another instance's namespace (`b.example:cache` owning `b.example:cache:*`).
 */
export function isInstanceId(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 253) return false;
  // label by label, with a single-character class per label, so no input can backtrack
  return s
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9-]+$/.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-"),
    );
}

/** Days a rotated-away key keeps verifying when its history entry names no `until`. */
const DEFAULT_ROTATION_GRACE_DAYS = 7;
const MAX_CLOCK_SKEW_S = 300;

/** One key a peer's frames may verify under: the pin (no `until`), or a predecessor until its cutoff. */
interface AcceptKey {
  x: string;
  until?: number;
}

/** The accept-set keys usable at `nowS`: the pin, plus predecessors whose cutoff has not passed. */
export function usableKeys(accept: AcceptKey[], nowS: number): string[] {
  return accept.filter((k) => k.until == null || k.until > nowS).map((k) => k.x);
}

/** Parse a stored accept set (fed_peers.accept_keys), tolerating a missing or malformed column. */
export function parseAcceptKeys(s: string | null | undefined): AcceptKey[] {
  return parseJsonArray<AcceptKey>(s ?? undefined).filter((k) => k && typeof k.x === "string" && k.x);
}

type PeerKeyResolution = { ok: true; pin: string | null; accept: AcceptKey[] } | { ok: false; reason: string };

/**
 * Decide which keys a peer's frames verify under, from its descriptor and what we stored before.
 *
 * - The pin moves only to a key the old pin reaches through verified rotation records (each new key
 *   signed by its predecessor). Being merely listed in `publicKeys` proves nothing: anyone who can
 *   edit the descriptor can list a key.
 * - A published key other than the current one is accepted only as a proven predecessor: a key
 *   we already trusted (the old pin, or one still in the stored accept set) from which a verified
 *   rotation chain leads to the current key. Its cutoff is its published `until`, else the rotation
 *   time plus the grace, and never later than the rotation time plus the grace.
 * - Revocation is successor-only and sticky: once a key has been rotated away from, its cutoff never
 *   moves later, so a later descriptor cannot revive it, and a rotated-away key never becomes the pin.
 */
export async function resolvePeerKeys(opts: {
  pinned: string | null;
  current: string | null;
  published: FedPublicKey[];
  rotations: RotationRecord[] | undefined;
  prior: AcceptKey[];
  nowS: number;
  graceDays?: number;
}): Promise<PeerKeyResolution> {
  const { pinned, current, nowS } = opts;
  if (!current) return pinned ? { ok: false, reason: "regressed to unsigned" } : { ok: true, pin: null, accept: [] };
  const grace = (opts.graceDays ?? DEFAULT_ROTATION_GRACE_DAYS) * 86400;

  const edges: RotationRecord[] = [];
  for (const r of opts.rotations ?? [])
    if (Number.isInteger(r?.at) && r.at <= nowS + MAX_CLOCK_SKEW_S && (await verifyRotationRecord(r))) edges.push(r);
  const reach = (from: string): Set<string> => {
    const seen = new Set([from]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of edges)
        if (seen.has(e.prevKey) && !seen.has(e.key)) {
          seen.add(e.key);
          grew = true;
        }
    }
    return seen;
  };
  const rotatedAwayAt = (x: string): number | null => {
    const ats = edges.filter((e) => e.prevKey === x && e.key !== x).map((e) => e.at);
    return ats.length ? Math.min(...ats) : null;
  };

  const priorUntil = new Map<string, number>();
  for (const k of opts.prior) if (k.until != null) priorUntil.set(k.x, k.until);
  if (priorUntil.has(current) || rotatedAwayAt(current) != null)
    return { ok: false, reason: "current key has been rotated away from" };
  if (pinned && pinned !== current && !reach(pinned).has(current))
    return { ok: false, reason: "key changed without a valid rotation proof" };

  // A predecessor must be a key we already trusted — the old pin, or a key already in the stored
  // accept set and not yet past its cutoff. A rotation record is signed by its own `prevKey`, so anyone
  // can mint one from a fresh key to the current key; only trust we held before can vouch for a key.
  // On first contact there is nothing to vouch with, so no predecessor is admitted.
  const trustedBefore = new Set<string>();
  if (pinned) trustedBefore.add(pinned);
  for (const k of opts.prior) if (k.until == null || k.until > nowS) trustedBefore.add(k.x);
  const accept: AcceptKey[] = [{ x: current }];
  const listed = new Set([current]);
  for (const k of opts.published) {
    if (!k?.x || listed.has(k.x) || k.revoked || !trustedBefore.has(k.x)) continue;
    const away = rotatedAwayAt(k.x);
    if (away == null || !reach(k.x).has(current)) continue; // not a proven predecessor of the current key
    // the grace never runs past the rotation time plus this instance's grace, whatever `until` says
    let until = Math.min(typeof k.until === "number" ? k.until : away + grace, away + grace);
    const was = priorUntil.get(k.x);
    if (was != null) until = Math.min(until, was);
    accept.push({ x: k.x, until });
    listed.add(k.x);
  }
  // keep every past cutoff, including expired ones, so the revocation outlives the descriptor
  for (const [x, until] of priorUntil) if (!listed.has(x)) accept.push({ x, until: Math.min(until, nowS) });
  // the old pin, if rotated away and no longer published, is revoked from now on
  if (pinned && pinned !== current && !listed.has(pinned) && !priorUntil.has(pinned))
    accept.push({ x: pinned, until: nowS });
  return { ok: true, pin: current, accept };
}

// ---- signed instance registry / namespace authority ----
export interface RegistryEntry {
  instance: string;
  url?: string;
  key?: string;
  operator?: string;
  aprsCall?: string;
  since?: number;
  /**
   * The instance's typed transport endpoints (https / 44net / ax25 / netrom / bbs), so a peer can be
   * reached over amateur space without coupling the serverless front-end to any IP block. Signed by the
   * registry authority, so it is a tamper-proof directory of who-is-reachable-where — but reachability
   * and addressing only, never a trust uplift.
   */
  addresses?: FedEndpoint[];
}
export interface SignedRegistry {
  entries: RegistryEntry[];
  at?: number;
  sig?: string;
  signer?: string;
}

/** Verify a registry document's authority signature (sig over the canonical {entries,at}). Pure/testable. */
export async function verifyRegistry(doc: SignedRegistry, authorityKeyB64url: string): Promise<boolean> {
  if (!doc?.sig || !Array.isArray(doc.entries)) return false;
  try {
    const k = await importVerifyKey(authorityKeyB64url);
    return verifyDomain(
      k,
      b64urlToBytes(doc.sig),
      SIG_DOMAIN.registry,
      stableStringify({ at: doc.at ?? 0, entries: doc.entries }),
    );
  } catch {
    return false;
  }
}

/** Verify a signed registry doc against a pinned key → instance→entry map (empty if invalid). */
async function registryToMap(doc: SignedRegistry, key: string): Promise<Map<string, RegistryEntry>> {
  const m = new Map<string, RegistryEntry>();
  if (!(await verifyRegistry(doc, key))) return m; // reject an unsigned / forged registry
  // The registry is authority-signed, but still normalize each entry's endpoint set through the
  // typed validator so a malformed address never rides the registry into a peer record.
  for (const e of doc.entries)
    if (e?.instance) m.set(e.instance, e.addresses ? { ...e, addresses: parseEndpoints(e.addresses) } : e);
  return m;
}

/**
 * Parse a federation-registry DNS `TXT` record (pure) — a `k=v;k=v` string that says where the
 * signed registry lives: `url=<https URL to the signed registry JSON>`. A `key=` token is parsed but
 * never trusted: the authority key is pinned in FED_REGISTRY_KEY, because whoever can change a TXT
 * record must not be able to choose the key that signs the registry. Later keys win; unknown tokens
 * are ignored. Returns `{}` when neither field is present.
 */
export function parseRegistryTxt(txt: string): { url?: string; key?: string } {
  const out: { url?: string; key?: string } = {};
  for (const tok of String(txt).replace(/^"|"$/g, "").split(";")) {
    const i = tok.indexOf("=");
    if (i < 0) continue;
    const k = tok.slice(0, i).trim().toLowerCase(),
      v = tok.slice(i + 1).trim();
    if (k === "url" && /^https:\/\//.test(v)) out.url = v;
    else if (k === "key" && v) out.key = v;
  }
  return out;
}

/** A registry that cannot be trusted as configured: federation refuses to guess instead. */
class RegistryConfigError extends Error {}

/**
 * Registry settings that would make the registry unverifiable, or null when they are sound. A
 * registry is only as strong as its authority key, so the key is always pinned in config: DNS
 * (FED_REGISTRY_DNS) locates the document, it never supplies the key. Node and Bun refuse to start
 * with such a setting; a gateway embedded without that check fails every registry lookup closed.
 */
export function federationConfigError(env: Env): string | null {
  if (env.FED_REGISTRY_DNS && !env.FED_REGISTRY_KEY)
    return "FED_REGISTRY_DNS is set without FED_REGISTRY_KEY: DNS only locates the registry, its authority key must be pinned in FED_REGISTRY_KEY";
  if (env.FED_REGISTRY && !env.FED_REGISTRY_KEY)
    return "FED_REGISTRY is set without FED_REGISTRY_KEY: the registry cannot be verified";
  return null;
}

const REGISTRY_TTL_MS = 5 * 60_000;
const registryCache = new WeakMap<object, { exp: number; map: Map<string, RegistryEntry> }>();

interface RegistryState {
  max_at: number;
  doc: string;
}

async function registryState(env: Env, authority: string): Promise<RegistryState | null> {
  try {
    return await env.DB.prepare("SELECT max_at, doc FROM fed_registry_state WHERE authority_key = ?")
      .bind(authority)
      .first<RegistryState>();
  } catch {
    return null;
  }
}

/**
 * Fetch the registry located by the FED_REGISTRY_DNS `TXT` record and verify it under the pinned
 * FED_REGISTRY_KEY. A document older than the newest one already accepted is a replay and is
 * refused. When no fresh document can be had (DoH, fetch, parse, signature or age failure), the last
 * good document keeps binding the instances it registered, so an outage never drops a registered
 * instance back to trust-on-first-use.
 */
async function registryFromDns(env: Env, name: string, authority: string): Promise<Map<string, RegistryEntry>> {
  const stored = await registryState(env, authority);
  try {
    const doh = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(3000),
    });
    if (doh.ok) {
      const answers = ((await doh.json()) as { Answer?: { data: string }[] }).Answer ?? [];
      for (const a of answers) {
        const { url } = parseRegistryTxt(a.data);
        if (!url) continue;
        const r = await fedFetch(env, url, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) continue;
        const doc = (await r.json()) as SignedRegistry;
        const at = Number.isInteger(doc?.at) ? (doc.at as number) : 0;
        if (stored && at < stored.max_at) continue; // a replayed older registry
        const map = await registryToMap(doc, authority);
        if (!map.size) continue;
        await env.DB.prepare(
          `INSERT INTO fed_registry_state (authority_key, max_at, doc, fetched_at) VALUES (?,?,?,?)
           ON CONFLICT(authority_key) DO UPDATE SET max_at = excluded.max_at, doc = excluded.doc,
             fetched_at = excluded.fetched_at WHERE excluded.max_at >= fed_registry_state.max_at`,
        )
          .bind(authority, at, JSON.stringify(doc), nowS())
          .run()
          .catch(() => {});
        return map;
      }
    }
  } catch {
    /* unreachable or malformed: fall back to the last good document below */
  }
  if (stored) {
    try {
      return await registryToMap(JSON.parse(stored.doc) as SignedRegistry, authority);
    } catch {
      /* a corrupt stored document binds nothing */
    }
  }
  return new Map();
}

/**
 * Load + verify the federation registry → instance→entry map. Source: FED_REGISTRY (a document in
 * config) or, failing that, the DNS-located FED_REGISTRY_DNS; both verify under FED_REGISTRY_KEY.
 * Empty when no registry is configured. Throws {@link RegistryConfigError} when the configuration
 * cannot be trusted (no pinned key, or a configured document that does not verify).
 */
export async function loadRegistry(env: Env): Promise<Map<string, RegistryEntry>> {
  const err = federationConfigError(env);
  if (err) throw new RegistryConfigError(err);
  const authority = env.FED_REGISTRY_KEY;
  if (env.FED_REGISTRY && authority) {
    let doc: SignedRegistry;
    try {
      doc = JSON.parse(env.FED_REGISTRY) as SignedRegistry;
    } catch {
      throw new RegistryConfigError("FED_REGISTRY is not valid JSON");
    }
    if (!(await verifyRegistry(doc, authority)))
      throw new RegistryConfigError("FED_REGISTRY does not verify under FED_REGISTRY_KEY");
    return registryToMap(doc, authority);
  }
  if (!env.FED_REGISTRY_DNS || !authority) return new Map();
  const hit = registryCache.get(env);
  if (hit && hit.exp > Date.now()) return hit.map;
  const map = await registryFromDns(env, env.FED_REGISTRY_DNS, authority);
  registryCache.set(env, { exp: Date.now() + REGISTRY_TTL_MS, map });
  return map;
}

/** Anti-spoof (pure): when the registry binds this instance to a key, the peer's current key MUST be
 *  that key — listing it next to another key proves nothing. An unregistered instance (or one with
 *  no bound key) falls back to trust-on-first-use. */
export function registryKeyAllowed(entry: RegistryEntry | undefined, currentKey: string | null): boolean {
  if (!entry || !entry.key) return true;
  return entry.key === currentKey;
}

/** This instance's own registry self-attestation (what it publishes about itself). */
export async function selfRegistryEntry(env: Env, instance: string): Promise<RegistryEntry> {
  const fk = await loadKey(env);
  const addresses = parseEndpoints(parseJsonArray(env.FED_ENDPOINTS));
  return {
    instance,
    key: fk?.publicX,
    operator: env.FED_OPERATOR,
    aprsCall: serviceCall(env),
    ...(addresses.length ? { addresses } : {}),
  };
}

/** Endpoint: this instance's verified view of the network registry + its own self-entry (transparency). */
export async function handleFederationRegistry(req: Request, env: Env): Promise<Response> {
  const instance = instanceOf(req, env);
  let reg: Map<string, RegistryEntry>;
  try {
    reg = await loadRegistry(env);
  } catch (e) {
    return json({
      self: await selfRegistryEntry(env, instance),
      entries: [],
      verified: false,
      error: (e as Error).message,
    });
  }
  return json({
    self: await selfRegistryEntry(env, instance),
    entries: [...reg.values()],
    verified: reg.size > 0 || !(env.FED_REGISTRY || env.FED_REGISTRY_DNS),
  });
}

/** Verify a rotation record's continuity: the new `key` is vouched for by `prevKey` (sig over {key,prevKey,at}). */
export async function verifyRotationRecord(r: RotationRecord): Promise<boolean> {
  if (!r?.key || !r.prevKey || !r.at || !r.sig) return false;
  try {
    const pk = await importVerifyKey(r.prevKey);
    return verifyDomain(
      pk,
      b64urlToBytes(r.sig),
      SIG_DOMAIN.rotation,
      stableStringify({ key: r.key, prevKey: r.prevKey, at: r.at }),
    );
  } catch {
    return false;
  }
}

/**
 * Verify an Ed25519 signature over a domain-prefixed canonical message. Only the prefixed form
 * verifies, so a signature made for one purpose can never be presented for another.
 */
export async function verifyDomain(
  key: CryptoKey,
  sig: ArrayBuffer | Uint8Array<ArrayBuffer>,
  domain: string,
  message: string,
): Promise<boolean> {
  return crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(domain + message));
}

/** Import a peer's raw Ed25519 public key (base64url) for verifying its frames. */
export function importVerifyKey(rawB64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64urlToBytes(rawB64url), { name: "Ed25519" }, false, ["verify"]);
}

/**
 * A fingerprint as an operator typed it (any case, with or without the spaces or colons between groups), in
 * keyFingerprint's form (`3f2a 9c01 bb7e 4d10`); null when it is not one.
 */
export function normalizeFingerprint(s: string): string | null {
  const hex = s.replace(/[\s:]/g, "").toLowerCase();
  return /^[0-9a-f]{16}$/.test(hex) ? hex.match(/.{4}/g)!.join(" ") : null;
}

/** One `FED_PEERS` entry: the peer's base URL, and the key fingerprint pinned after a `#`, if any. */
interface ConfiguredPeer {
  url: string;
  fingerprint: string | null;
}

/**
 * Parse `FED_PEERS`: comma-separated base URLs, each optionally followed by `#<fingerprint>`, the peer's
 * key fingerprint as its sysop gave it. A suffix that is not a fingerprint pins nothing and the entry is
 * seeded unpinned, so a typo can only ever leave a peer unvetted.
 */
export function parseFedPeers(raw: string | undefined): ConfiguredPeer[] {
  const out: ConfiguredPeer[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const hash = entry.indexOf("#");
    const url = trimTrailingSlashes((hash < 0 ? entry : entry.slice(0, hash)).trim());
    if (!url) continue;
    const fingerprint = hash < 0 ? null : normalizeFingerprint(entry.slice(hash + 1));
    if (hash >= 0 && !fingerprint)
      console.warn(`federation: the FED_PEERS entry for ${url} carries a suffix that is not a key fingerprint`);
    out.push({ url, fingerprint });
  }
  return out;
}

export function instanceOf(req: Request, env: Env): string {
  return env.INSTANCE ?? new URL(req.url).host;
}

// ---- endpoints ----
export async function handleWellKnown(req: Request, env: Env): Promise<Response> {
  const fk = await loadKey(env);
  const listsPeers = peerExchangeOn(env);
  return json({
    protocol: PROTOCOL,
    protocolVersions: PROTOCOL_VERSIONS,
    instance: instanceOf(req, env),
    software: "aprscaching",
    capabilities: [
      "caches",
      "finds",
      "keys",
      "tombstones",
      "moves",
      "bulletins",
      "notify",
      fk ? "sync-cbor" : null, // the CBOR sync surface exists only where frames can carry signatures
      env.FED_SUBMIT_SECRET ? "submit" : null,
      fk ? "corroborate-signed/1" : null, // signed corroboration questions and answers
      fk ? SYNC_REGION_CAPABILITY : null, // the CBOR caches feed narrows to a region (fedregion.ts)
      fk ? ORIGIN_SYNC_CAPABILITY : null, // the per-origin summary and pages (fedtransit.ts)
      listsPeers ? PEER_EXCHANGE_CAPABILITY : null, // the instances this one trusts (feddiscover.ts)
    ].filter(Boolean),
    endpoints: {
      caches: "/federation/caches",
      finds: "/federation/finds",
      keys: "/federation/keys",
      tombstones: "/federation/tombstones",
      "account-moves": "/federation/account-moves",
      notify: "/federation/notify",
      ...(fk && { summary: "/federation/sync/summary", origin: "/federation/sync/origin" }),
      ...(listsPeers && { exchange: PEER_EXCHANGE_PATH }),
    },
    sigAlg: "Ed25519",
    signed: !!fk,
    publicKey: fk?.publicX ?? null, // the current signing key (raw Ed25519, base64url): the key a peer pins
    publicKeyJwk: fk?.jwk ?? null,
    publicKeys: await instanceKeys(env), // current + previous keys + revocations, each {x,since?,until?,revoked?}
    rotations: parseJsonArray<RotationRecord>(env.FED_ROTATIONS), // continuity proofs (new key signed by old)
    operator: env.FED_OPERATOR ?? null, // self-published operator + APRS service address
    aprsCall: serviceCall(env),
    // Typed transport endpoints this instance is reachable on (https / 44net / ax25 / netrom /
    // bbs) — the instance's own multi-address set, distinct from `endpoints` (the feed-path map).
    addresses: parseEndpoints(parseJsonArray(env.FED_ENDPOINTS)),
  });
}

/**
 * Generalized feed envelope. Every record type rides ONE serve path: select rows, shape each into
 * `{type,id,cursor,data}`, and emit the standard `{instance,type,since,nextCursor,count,complete,
 * items}` envelope. A new feed type is just a `FeedServeDef` — no bespoke endpoint code. The JSON
 * feeds are a transparency/browse surface: signatures live on the CBOR sync surface, the only wire
 * mirroring consumes.
 */
/** What a subscriber may narrow a feed to; only the caches feed honours a region. */
export interface FeedFilter {
  bbox?: Bbox;
}

export interface FeedServeDef<Row = any> {
  type: string;
  /**
   * Rows after a cursor. A feed whose cursor can repeat (a timestamp) is `composite`: it also takes
   * `sinceId` and returns rows strictly after `(since, sinceId)`, ordered by `(cursor, id)`; without
   * `sinceId` it returns rows with a cursor `>= since`.
   */
  selectRows(env: Env, since: number, limit: number, sinceId?: number, filter?: FeedFilter): Promise<Row[]>;
  composite?: boolean;
  /** A row's wire form. The cursor is also the record's version (`v`). */
  recordOf(row: Row, instance: string): { id: string; cursor: number; data: unknown };
}

function feedParams(req: Request): { since: number; limit: number } {
  const u = new URL(req.url);
  return {
    since: Math.max(0, Number(u.searchParams.get("since") ?? 0) || 0),
    limit: Math.min(Math.max(Number(u.searchParams.get("limit") ?? 200) || 200, 1), 1000),
  };
}

/** Build the record items for a feed page (the browse surface — mirroring pulls CBOR frames). */
async function buildFeed(
  env: Env,
  instance: string,
  def: FeedServeDef,
  since: number,
  limit: number,
): Promise<{ items: Record<string, unknown>[]; nextCursor: number; complete: boolean }> {
  const rows = await def.selectRows(env, since, limit);
  let nextCursor = since;
  const items: Record<string, unknown>[] = [];
  for (const r of rows) {
    const { id, cursor, data } = def.recordOf(r, instance);
    items.push({ type: def.type, id, cursor, data, signer: instance });
    if (cursor > nextCursor) nextCursor = cursor;
  }
  return { items, nextCursor, complete: items.length < limit };
}

export async function serveFeed(req: Request, env: Env, def: FeedServeDef): Promise<Response> {
  const { since, limit } = feedParams(req);
  const instance = instanceOf(req, env);
  const { items, nextCursor, complete } = await buildFeed(env, instance, def, since, limit);
  return json({ instance, type: def.type, since, nextCursor, count: items.length, complete, items });
}

// only NATIVE caches are federated; imported third-party data stays local
/** A native cache's current federation version, the `v` its next frame carries: its place in the caches sequence. */
export async function cacheFedVersion(env: Env, id: number): Promise<number> {
  const r = await env.DB.prepare("SELECT fed_rev FROM caches WHERE id = ?").bind(id).first<{ fed_rev: number }>();
  return r?.fed_rev ?? 0;
}
/**
 * The global id of this instance's cache `id`: `<instance>:cache:<fed_id>`, the number the cache took from the
 * caches sequence when it was made. A database restored from an older backup hands its ids out again, never a
 * sequence number, so a new cache never takes the global id of one its peers hold or deleted.
 */
export async function cacheGid(env: Env, instance: string, id: number): Promise<string> {
  const r = await env.DB.prepare("SELECT fed_id FROM caches WHERE id = ?").bind(id).first<{ fed_id: number }>();
  return `${instance}:cache:${r?.fed_id ?? id}`;
}
/** The global id of this instance's find `id`, its place in the finds sequence (see cacheGid). */
export async function findGid(env: Env, instance: string, id: number): Promise<string> {
  const r = await env.DB.prepare("SELECT fed_seq FROM cache_logs WHERE id = ?").bind(id).first<{ fed_seq: number }>();
  return `${instance}:find:${r?.fed_seq ?? id}`;
}
/**
 * The caches feed pages by `fed_rev`, which every insert and update of a cache takes from one counter
 * (`fed_cache_rev`): it rises across all of this instance's caches, so it is both a cache's version and the
 * feed's cursor, and a cache edited twice in one second takes two positions.
 */
export const CACHE_FEED: FeedServeDef<CacheRow> = {
  type: "cache",
  selectRows: async (env, since, limit, _sinceId, filter) => {
    // a region narrows the rows before the cursor walks them, so the cursor stays exact for that region
    const region = filter?.bbox ? bboxWhere(filter.bbox) : null;
    return (
      await env.DB.prepare(
        `SELECT * FROM caches WHERE source = 'native' AND fed_scope != 'local-only' AND removed_at IS NULL
           ${region ? `AND ${region.sql}` : ""} AND fed_rev > ? ORDER BY fed_rev LIMIT ?`,
      )
        .bind(...(region?.params ?? []), since, limit)
        .all<CacheRow>()
    ).results;
  },
  recordOf: (r, instance) => ({ id: `${instance}:cache:${r.fed_id}`, cursor: r.fed_rev ?? 0, data: cacheData(r) }),
};
export const FIND_FEED: FeedServeDef<FindRow> = {
  type: "find",
  selectRows: async (env, since, limit) =>
    (
      await env.DB.prepare(
        // finds federate only with their cache: never on a local-only or imported cache
        `SELECT l.*, c.code AS cache_code, c.fed_id AS cache_fed_id FROM cache_logs l
       JOIN caches c ON c.id = l.cache_id
      WHERE l.fed_seq > ? AND c.source = 'native' AND c.fed_scope != 'local-only' ORDER BY l.fed_seq LIMIT ?`,
      )
        .bind(since, limit)
        .all<FindRow>()
    ).results,
  // the global id, the cursor and the version are the find's place in the finds sequence, never handed out again
  recordOf: (r, instance) => ({
    id: `${instance}:find:${r.fed_seq}`,
    cursor: r.fed_seq,
    data: findData(r, instance),
  }),
};
export const KEY_FEED: FeedServeDef<KeyRow> = {
  type: "key",
  selectRows: async (env, since, limit) => {
    const rows = (
      await env.DB.prepare(
        "SELECT id, callsign, public_key, created_at FROM callsign_keys WHERE id > ? ORDER BY id LIMIT ?",
      )
        .bind(since, limit)
        .all<Omit<KeyRow, "verified">>()
    ).results;
    const verified = await verificationsOf(
      env,
      rows.map((r) => r.callsign),
    );
    return rows.map((r) => ({ ...r, verified: verified.has(baseCall(r.callsign)) }));
  },
  recordOf: (r, instance) => ({ id: `${instance}:key:${r.id}`, cursor: r.id, data: keyData(r) }),
};

export const handleFederationCaches = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, CACHE_FEED);
export const handleFederationFinds = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, FIND_FEED);
export const handleFederationKeys = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, KEY_FEED);
