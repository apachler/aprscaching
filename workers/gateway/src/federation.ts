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

// ---- D1 row shapes (subset) ----
interface CacheRow {
  id: number; code: string; owner_call: string; title: string; type: string; status: string;
  difficulty: number; terrain: number; lat: number | null; lon: number | null;
  station_call: string | null; source: string; external_id: string | null;
  hint: string | null; description: string | null; min_trust: string | null;
  created_at: number; updated_at: number;
}
interface FindRow {
  id: number; cache_id: number; cache_code: string | null; logger_call: string; ts: number;
  log_type: string; verified: number; tier: string | null; verify_method: string | null;
  distance_m: number | null; comment: string | null;
}

function cacheData(r: CacheRow) {
  return {
    code: r.code, ownerCall: r.owner_call, title: r.title, type: r.type, status: r.status,
    difficulty: r.difficulty, terrain: r.terrain, lat: r.lat, lon: r.lon,
    stationCall: r.station_call, source: r.source, externalId: r.external_id,
    hint: r.hint, description: r.description, minTrust: r.min_trust,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function findData(r: FindRow, instance: string) {
  return {
    cacheId: `${instance}:cache:${r.cache_id}`, cacheCode: r.cache_code,
    loggerCall: r.logger_call, ts: r.ts, logType: r.log_type,
    verified: r.verified === 1, tier: r.tier, verifyMethod: r.verify_method,
    distanceM: r.distance_m, comment: r.comment,
  };
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
function fromB64(b64: string): ArrayBuffer {
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
    instance: instanceOf(req, env),
    software: "aprscaching",
    capabilities: ["caches", "finds"],
    endpoints: { caches: "/federation/caches", finds: "/federation/finds" },
    sigAlg: "Ed25519",
    signed: !!fk,
    publicKey: fk?.publicX ?? null,        // raw Ed25519 public key (base64url)
    publicKeyJwk: fk?.jwk ?? null,
    peers,
  });
}

export async function handleFederationCaches(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const since = Math.max(0, Number(u.searchParams.get("since") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 200) || 200, 1), 1000);
  const instance = instanceOf(req, env);
  const fk = await loadKey(env);

  const rows = (await env.DB.prepare(
    "SELECT * FROM caches WHERE updated_at >= ? ORDER BY updated_at, id LIMIT ?",
  ).bind(since, limit).all<CacheRow>()).results;

  let nextCursor = since;
  const items = [];
  for (const r of rows) {
    const id = `${instance}:cache:${r.id}`;
    const data = cacheData(r);
    const rec: Record<string, unknown> = { type: "cache", id, cursor: r.updated_at, data };
    if (fk) { rec.sig = await sign(fk, "cache", id, data); rec.signer = instance; }
    items.push(rec);
    if (r.updated_at > nextCursor) nextCursor = r.updated_at;
  }
  return json({ instance, type: "cache", since, nextCursor, count: items.length, complete: items.length < limit, items });
}

export async function handleFederationFinds(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const since = Math.max(0, Number(u.searchParams.get("since") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 200) || 200, 1), 1000);
  const instance = instanceOf(req, env);
  const fk = await loadKey(env);

  const rows = (await env.DB.prepare(
    `SELECT l.*, c.code AS cache_code FROM cache_logs l
       LEFT JOIN caches c ON c.id = l.cache_id
      WHERE l.id > ? ORDER BY l.id LIMIT ?`,
  ).bind(since, limit).all<FindRow>()).results;

  let nextCursor = since;
  const items = [];
  for (const r of rows) {
    const id = `${instance}:find:${r.id}`;
    const data = findData(r, instance);
    const rec: Record<string, unknown> = { type: "find", id, cursor: r.id, data };
    if (fk) { rec.sig = await sign(fk, "find", id, data); rec.signer = instance; }
    items.push(rec);
    if (r.id > nextCursor) nextCursor = r.id;
  }
  return json({ instance, type: "find", since, nextCursor, count: items.length, complete: items.length < limit, items });
}
