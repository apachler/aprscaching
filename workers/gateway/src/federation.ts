// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * federation.ts — read-only, mirrorable, signed feeds.
 *
 * An instance publishes its caches and find logs so peers can mirror them and build a global
 * catalog. Records are Ed25519-signed by the instance (WebCrypto — same code on
 * Cloudflare Workers and Node) so a mirror can verify provenance + integrity. The envelope is
 * shaped so per-callsign signing slots in without a format change (signer becomes a callsign, not the instance).
 *
 *   GET /.well-known/aprscaching        instance descriptor + public key + peers
 *   GET /federation/caches?since=<ts>   signed cache records (cursor = updated_at high-water mark)
 *   GET /federation/finds?since=<id>    signed find records  (cursor = append-only log id)
 *
 * Cursors are high-water marks; re-fetching the boundary is safe because records are idempotent
 * by `id` (a mirror upserts on the namespaced id).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { parseEndpoints, type FedEndpoint } from "@aprscaching/shared";

const PROTOCOL = "aprscaching-federation/0.1";
/** Wire protocol versions this instance speaks. 0.2 adds the generalized envelope + negotiation. */
export const FED_PROTOCOL_VERSION = "0.2";
const PROTOCOL_VERSIONS = ["0.1", "0.2"];

// ---- D1 row shapes (subset) ----
interface CacheRow {
  id: number;
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
}
interface FindRow {
  id: number;
  cache_id: number;
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
  verified: number;
  created_at: number;
}

function cacheData(r: CacheRow) {
  // Redaction: the hint is a spoiler and NEVER federates; an `unlisted` cache withholds its
  // description too (location/title only). `local-only` caches are filtered out before this (CACHE_FEED).
  return {
    code: r.code,
    ownerCall: r.owner_call,
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
    cacheId: `${instance}:cache:${r.cache_id}`,
    cacheCode: r.cache_code,
    loggerCall: r.logger_call,
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
  return { callsign: r.callsign, publicKey: r.public_key, verified: r.verified === 1, createdAt: r.created_at };
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
export function fromB64(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface FedKey {
  key: CryptoKey;
  publicX: string;
  jwk: { kty: string; crv: string; x: string };
}
let keyCache: Promise<FedKey | null> | undefined;
/**
 * FED_PRIVATE_KEY is base64(JSON({ pkcs8, pub })) — see tools/fedkey/genkey.mjs. We import the
 * private key as PKCS8 (supported on both workerd and Node; the Ed25519 *private JWK* import is
 * not portable) and publish the raw public key (base64url) for consumers to verify.
 */
function loadKey(env: Env): Promise<FedKey | null> {
  if (keyCache) return keyCache;
  const p: Promise<FedKey | null> = (async () => {
    if (!env.FED_PRIVATE_KEY) return null; // legitimately unconfigured → a cacheable null
    const { pkcs8, pub } = JSON.parse(new TextDecoder().decode(fromB64(env.FED_PRIVATE_KEY)));
    const key = await crypto.subtle.importKey("pkcs8", fromB64(pkcs8), { name: "Ed25519" }, false, ["sign"]);
    return { key, publicX: pub, jwk: { kty: "OKP", crv: "Ed25519", x: pub } };
  })().catch((e) => {
    // A configured key that fails to import is a TRANSIENT error — memoizing it as null
    // would make the instance silently serve unsigned feeds for its whole life. Log it and clear the
    // cache so the next call retries instead of sticking on the failure.
    console.error("federation signing key load failed (will retry):", (e as Error).message);
    if (keyCache === p) keyCache = undefined;
    return null;
  });
  keyCache = p;
  return p;
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

/** Import a peer's ACTIVE published keys (falling back to a legacy single `publicKey`) for verifying its feed. */
export async function importActiveKeys(
  publicKeys: FedPublicKey[] | undefined,
  fallback: string | null,
  nowS: number,
): Promise<CryptoKey[]> {
  const xs =
    Array.isArray(publicKeys) && publicKeys.length ? activeFedKeys(publicKeys, nowS) : fallback ? [fallback] : [];
  const out: CryptoKey[] = [];
  for (const x of xs) {
    try {
      out.push(await importVerifyKey(x));
    } catch {
      /* skip an unparseable key */
    }
  }
  return out;
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
    const msg = new TextEncoder().encode(stableStringify({ at: doc.at ?? 0, entries: doc.entries }));
    return crypto.subtle.verify("Ed25519", k, fromB64(doc.sig), msg);
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
 * Parse a federation-registry DNS `TXT` record (pure) — a `k=v;k=v` string that anchors the signed
 * registry off DNS instead of an env var: `url=<https URL to the signed registry JSON>; key=<authority
 * base64url>`. Later keys win; unknown tokens ignored. Returns `{}` when neither field is present.
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

/** Fetch the registry via a DNS `TXT` anchor: DoH-resolve FED_REGISTRY_DNS, follow its url+key. */
async function registryFromDns(env: Env): Promise<Map<string, RegistryEntry>> {
  const name = env.FED_REGISTRY_DNS;
  if (!name) return new Map();
  try {
    const doh = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!doh.ok) return new Map();
    const answers = ((await doh.json()) as { Answer?: { data: string }[] }).Answer ?? [];
    for (const a of answers) {
      const { url, key } = parseRegistryTxt(a.data);
      if (!url || !key) continue;
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const map = await registryToMap((await r.json()) as SignedRegistry, key);
      if (map.size) return map;
    }
  } catch {
    /* DoH / fetch / parse failure → no registry */
  }
  return new Map();
}

/** Load + verify the federation registry → instance→entry map. Source: FED_REGISTRY env, else a DNS TXT
 *  anchor (FED_REGISTRY_DNS). Empty when absent/invalid/forged. */
export async function loadRegistry(env: Env): Promise<Map<string, RegistryEntry>> {
  if (env.FED_REGISTRY && env.FED_REGISTRY_KEY) {
    try {
      return await registryToMap(JSON.parse(env.FED_REGISTRY) as SignedRegistry, env.FED_REGISTRY_KEY);
    } catch {
      return new Map();
    }
  }
  return registryFromDns(env);
}

/** Anti-spoof (pure): if the registry binds this instance to a key, its published keys MUST
 *  include it; an unregistered instance (or one with no bound key) falls back to TOFU. */
export function registryKeyAllowed(entry: RegistryEntry | undefined, activeKeyStrings: string[]): boolean {
  if (!entry || !entry.key) return true;
  return activeKeyStrings.includes(entry.key);
}

/** This instance's own registry self-attestation (what it publishes about itself). */
export async function selfRegistryEntry(env: Env, instance: string): Promise<RegistryEntry> {
  const fk = await loadKey(env);
  const addresses = parseEndpoints(parseJsonArray(env.FED_ENDPOINTS));
  return {
    instance,
    key: fk?.publicX,
    operator: env.FED_OPERATOR,
    aprsCall: env.FED_APRS_CALL,
    ...(addresses.length ? { addresses } : {}),
  };
}

/** Endpoint: this instance's verified view of the network registry + its own self-entry (transparency). */
export async function handleFederationRegistry(req: Request, env: Env): Promise<Response> {
  const instance = instanceOf(req, env);
  const reg = await loadRegistry(env);
  return json({
    self: await selfRegistryEntry(env, instance),
    entries: [...reg.values()],
    verified: reg.size > 0 || !env.FED_REGISTRY,
  });
}

/** Verify a rotation record's continuity: the new `key` is vouched for by `prevKey` (sig over {key,prevKey,at}). */
export async function verifyRotationRecord(r: RotationRecord): Promise<boolean> {
  if (!r?.key || !r.prevKey || !r.at || !r.sig) return false;
  try {
    const pk = await importVerifyKey(r.prevKey);
    const msg = new TextEncoder().encode(stableStringify({ key: r.key, prevKey: r.prevKey, at: r.at }));
    return crypto.subtle.verify("Ed25519", pk, fromB64(r.sig), msg);
  } catch {
    return false;
  }
}

/** Import a peer's raw Ed25519 public key (base64url) for verifying its frames. */
export function importVerifyKey(rawB64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(rawB64url), { name: "Ed25519" }, false, ["verify"]);
}

export function instanceOf(req: Request, env: Env): string {
  return env.INSTANCE ?? new URL(req.url).host;
}

// ---- endpoints ----
export async function handleWellKnown(req: Request, env: Env): Promise<Response> {
  const fk = await loadKey(env);
  const peers = (env.FED_PEERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    ].filter(Boolean),
    endpoints: {
      caches: "/federation/caches",
      finds: "/federation/finds",
      keys: "/federation/keys",
      tombstones: "/federation/tombstones",
      "account-moves": "/federation/account-moves",
      notify: "/federation/notify",
    },
    sigAlg: "Ed25519",
    signed: !!fk,
    publicKey: fk?.publicX ?? null, // current raw Ed25519 public key (base64url) — legacy single-key field
    publicKeyJwk: fk?.jwk ?? null,
    publicKeys: await instanceKeys(env), // current + previous keys + revocations, each {x,since?,until?,revoked?}
    rotations: parseJsonArray<RotationRecord>(env.FED_ROTATIONS), // continuity proofs (new key signed by old)
    operator: env.FED_OPERATOR ?? null, // self-published operator + APRS service address
    aprsCall: env.FED_APRS_CALL ?? null,
    // Typed transport endpoints this instance is reachable on (https / 44net / ax25 / netrom /
    // bbs) — the instance's own multi-address set, distinct from `endpoints` (the feed-path map).
    addresses: parseEndpoints(parseJsonArray(env.FED_ENDPOINTS)),
    peers,
  });
}

/**
 * Generalized feed envelope. Every record type rides ONE serve path: select rows, shape each into
 * `{type,id,cursor,data}`, and emit the standard `{instance,type,since,nextCursor,count,complete,
 * items}` envelope. A new feed type is just a `FeedServeDef` — no bespoke endpoint code. The JSON
 * feeds are a transparency/browse surface: signatures live on the CBOR sync surface, the only wire
 * mirroring consumes.
 */
export interface FeedServeDef<Row = any> {
  type: string;
  selectRows(env: Env, since: number, limit: number): Promise<Row[]>;
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
export async function buildFeed(
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
export const CACHE_FEED: FeedServeDef<CacheRow> = {
  type: "cache",
  selectRows: async (env, since, limit) =>
    (
      await env.DB.prepare(
        "SELECT * FROM caches WHERE source = 'native' AND fed_scope != 'local-only' AND updated_at >= ? ORDER BY updated_at, id LIMIT ?",
      )
        .bind(since, limit)
        .all<CacheRow>()
    ).results,
  recordOf: (r, instance) => ({ id: `${instance}:cache:${r.id}`, cursor: r.updated_at, data: cacheData(r) }),
};
export const FIND_FEED: FeedServeDef<FindRow> = {
  type: "find",
  selectRows: async (env, since, limit) =>
    (
      await env.DB.prepare(
        `SELECT l.*, c.code AS cache_code FROM cache_logs l
       LEFT JOIN caches c ON c.id = l.cache_id
      WHERE l.id > ? ORDER BY l.id LIMIT ?`,
      )
        .bind(since, limit)
        .all<FindRow>()
    ).results,
  recordOf: (r, instance) => ({ id: `${instance}:find:${r.id}`, cursor: r.id, data: findData(r, instance) }),
};
export const KEY_FEED: FeedServeDef<KeyRow> = {
  type: "key",
  selectRows: async (env, since, limit) =>
    (
      await env.DB.prepare("SELECT * FROM callsign_keys WHERE id > ? ORDER BY id LIMIT ?")
        .bind(since, limit)
        .all<KeyRow>()
    ).results,
  recordOf: (r, instance) => ({ id: `${instance}:key:${r.id}`, cursor: r.id, data: keyData(r) }),
};

export const handleFederationCaches = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, CACHE_FEED);
export const handleFederationFinds = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, FIND_FEED);
export const handleFederationKeys = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, KEY_FEED);
