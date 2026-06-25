/**
 * federation.ts — F1: read-only, mirrorable, signed feeds.
 *
 * An instance publishes its caches and find logs so peers can mirror them and build a global
 * catalog (see docs/06). Records are Ed25519-signed by the instance (WebCrypto — same code on
 * Cloudflare Workers and Node) so a mirror can verify provenance + integrity. The envelope is
 * shaped so per-callsign signing can slot in later (signer becomes a callsign, not the instance).
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

const PROTOCOL = "aprscaching-federation/0.1";
/** Wire protocol versions this instance speaks. 0.2 adds the generalized envelope + negotiation (T2.2). */
export const FED_PROTOCOL_VERSION = "0.2";
const PROTOCOL_VERSIONS = ["0.1", "0.2"];

// ---- D1 row shapes (subset) ----
interface CacheRow {
  id: number; code: string; owner_call: string; title: string; type: string; status: string;
  difficulty: number; terrain: number; lat: number | null; lon: number | null;
  station_call: string | null; source: string; external_id: string | null;
  hint: string | null; description: string | null; min_trust: string | null; fed_scope: string;
  created_at: number; updated_at: number;
}
interface FindRow {
  id: number; cache_id: number; cache_code: string | null; logger_call: string; ts: number;
  log_type: string; verified: number; tier: string | null; verify_method: string | null;
  distance_m: number | null; comment: string | null;
  signer_key: string | null; author_sig: string | null; signed_at: number | null;
}
interface KeyRow { id: number; callsign: string; public_key: string; verified: number; created_at: number }

function cacheData(r: CacheRow) {
  // T3.3 redaction: the hint is a spoiler and NEVER federates; an `unlisted` cache withholds its
  // description too (location/title only). `local-only` caches are filtered out before this (CACHE_FEED).
  return {
    code: r.code, ownerCall: r.owner_call, title: r.title, type: r.type, status: r.status,
    difficulty: r.difficulty, terrain: r.terrain, lat: r.lat, lon: r.lon,
    stationCall: r.station_call, source: r.source, externalId: r.external_id,
    description: r.fed_scope === "unlisted" ? null : r.description, minTrust: r.min_trust,
    fedScope: r.fed_scope,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function findData(r: FindRow, instance: string) {
  return {
    cacheId: `${instance}:cache:${r.cache_id}`, cacheCode: r.cache_code,
    loggerCall: r.logger_call, ts: r.ts, logType: r.log_type,
    verified: r.verified === 1, tier: r.tier, verifyMethod: r.verify_method,
    distanceM: r.distance_m, comment: r.comment,
    // per-callsign authorship signature (F0): self-contained, verifiable by anyone
    authorKey: r.signer_key, authorSig: r.author_sig, signedAt: r.signed_at,
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
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
function b64url(buf: ArrayBuffer): string {
  let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface FedKey { key: CryptoKey; publicX: string; jwk: { kty: string; crv: string; x: string } }
let keyCache: Promise<FedKey | null> | undefined;
/**
 * FED_PRIVATE_KEY is base64(JSON({ pkcs8, pub })) — see tools/fedkey/genkey.mjs. We import the
 * private key as PKCS8 (supported on both workerd and Node; the Ed25519 *private JWK* import is
 * not portable) and publish the raw public key (base64url) for consumers to verify.
 */
function loadKey(env: Env): Promise<FedKey | null> {
  if (keyCache) return keyCache;
  keyCache = (async () => {
    if (!env.FED_PRIVATE_KEY) return null;
    const { pkcs8, pub } = JSON.parse(new TextDecoder().decode(fromB64(env.FED_PRIVATE_KEY)));
    const key = await crypto.subtle.importKey("pkcs8", fromB64(pkcs8), { name: "Ed25519" }, false, ["sign"]);
    return { key, publicX: pub, jwk: { kty: "OKP", crv: "Ed25519", x: pub } };
  })().catch(() => null);
  return keyCache;
}
async function sign(fk: FedKey, type: string, id: string, data: unknown): Promise<string> {
  const msg = new TextEncoder().encode(stableStringify({ type, id, data }));
  return b64url(await crypto.subtle.sign("Ed25519", fk.key, msg));
}

/**
 * Serve-time feed signer (shared with new feeds, e.g. tombstones). Returns a closure that signs a
 * `{type,id,data}` record exactly like the caches/finds/keys feeds, or null if the instance has no
 * FED_PRIVATE_KEY (feeds are then served unsigned). Callers set `rec.signer = instance` when signed.
 */
export async function feedSigner(env: Env): Promise<((type: string, id: string, data: unknown) => Promise<string>) | null> {
  const fk = await loadKey(env);
  if (!fk) return null;
  return (type, id, data) => sign(fk, type, id, data);
}

/** Import a peer's raw Ed25519 public key (base64url) for verifying its feed (F2). */
export function importVerifyKey(rawB64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(rawB64url), { name: "Ed25519" }, false, ["verify"]);
}

/** Verify a feed record's signature against the canonical {type,id,data}. */
export async function verifyRecordSig(
  key: CryptoKey,
  rec: { type: string; id: string; data: unknown; sig?: string },
): Promise<boolean> {
  if (!rec.sig) return false;
  const msg = new TextEncoder().encode(stableStringify({ type: rec.type, id: rec.id, data: rec.data }));
  return crypto.subtle.verify("Ed25519", key, fromB64(rec.sig), msg);
}

function instanceOf(req: Request, env: Env): string {
  return env.INSTANCE ?? new URL(req.url).host;
}

// ---- endpoints ----
export async function handleWellKnown(req: Request, env: Env): Promise<Response> {
  const fk = await loadKey(env);
  const peers = (env.FED_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return json({
    protocol: PROTOCOL,
    protocolVersions: PROTOCOL_VERSIONS,
    instance: instanceOf(req, env),
    software: "aprscaching",
    capabilities: ["caches", "finds", "keys", "tombstones", "moves", "notify", env.FED_SUBMIT_SECRET ? "submit" : null].filter(Boolean),
    endpoints: { caches: "/federation/caches", finds: "/federation/finds", keys: "/federation/keys", tombstones: "/federation/tombstones", "account-moves": "/federation/account-moves", notify: "/federation/notify" },
    sigAlg: "Ed25519",
    signed: !!fk,
    publicKey: fk?.publicX ?? null,        // raw Ed25519 public key (base64url)
    publicKeyJwk: fk?.jwk ?? null,
    peers,
  });
}

/**
 * Generalized feed envelope (T2.2). Every record type rides ONE serve path: select rows, shape each
 * into `{type,id,cursor,data}`, sign at serve time, and emit the standard
 * `{instance,type,since,nextCursor,count,complete,items}` envelope. A new feed type is just a
 * `FeedServeDef` (used by tombstones.ts and future presence/badge/account-move feeds) — no bespoke
 * endpoint or signing code.
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

/** Build the signed record items for a feed page (shared by serveFeed and the push-to-hub client, T2.3). */
export async function buildFeed(
  env: Env, instance: string, def: FeedServeDef, since: number, limit: number,
): Promise<{ items: Record<string, unknown>[]; nextCursor: number; complete: boolean }> {
  const sign = await feedSigner(env);
  const rows = await def.selectRows(env, since, limit);
  let nextCursor = since;
  const items: Record<string, unknown>[] = [];
  for (const r of rows) {
    const { id, cursor, data } = def.recordOf(r, instance);
    const rec: Record<string, unknown> = { type: def.type, id, cursor, data };
    if (sign) { rec.sig = await sign(def.type, id, data); rec.signer = instance; }
    items.push(rec);
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

/** This instance's raw Ed25519 public key (base64url), or null if unsigned — for push-to-hub (T2.3). */
export async function feedPublicKey(env: Env): Promise<string | null> {
  return (await loadKey(env))?.publicX ?? null;
}

// only NATIVE caches are federated; imported third-party data stays local (M3 decision)
export const CACHE_FEED: FeedServeDef<CacheRow> = {
  type: "cache",
  selectRows: async (env, since, limit) => (await env.DB.prepare(
    "SELECT * FROM caches WHERE source = 'native' AND fed_scope != 'local-only' AND updated_at >= ? ORDER BY updated_at, id LIMIT ?",
  ).bind(since, limit).all<CacheRow>()).results,
  recordOf: (r, instance) => ({ id: `${instance}:cache:${r.id}`, cursor: r.updated_at, data: cacheData(r) }),
};
export const FIND_FEED: FeedServeDef<FindRow> = {
  type: "find",
  selectRows: async (env, since, limit) => (await env.DB.prepare(
    `SELECT l.*, c.code AS cache_code FROM cache_logs l
       LEFT JOIN caches c ON c.id = l.cache_id
      WHERE l.id > ? ORDER BY l.id LIMIT ?`,
  ).bind(since, limit).all<FindRow>()).results,
  recordOf: (r, instance) => ({ id: `${instance}:find:${r.id}`, cursor: r.id, data: findData(r, instance) }),
};
export const KEY_FEED: FeedServeDef<KeyRow> = {
  type: "key",
  selectRows: async (env, since, limit) => (await env.DB.prepare(
    "SELECT * FROM callsign_keys WHERE id > ? ORDER BY id LIMIT ?",
  ).bind(since, limit).all<KeyRow>()).results,
  recordOf: (r, instance) => ({ id: `${instance}:key:${r.id}`, cursor: r.id, data: keyData(r) }),
};

export const handleFederationCaches = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, CACHE_FEED);
export const handleFederationFinds = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, FIND_FEED);
export const handleFederationKeys = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, KEY_FEED);
