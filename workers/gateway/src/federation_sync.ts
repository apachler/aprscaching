/**
 * federation_sync.ts — F2: the consumer side. Pull peers' /federation feeds, verify each record's
 * Ed25519 signature against the public key they publish at /.well-known/aprscaching, and mirror
 * the records locally (remote_caches / remote_finds). Per-peer cursors make it incremental.
 *
 * Runtime-neutral (fetch + crypto.subtle + env.DB) → runs on Cloudflare and Node alike.
 * Mirrored rows are display-only: we never re-publish them and never mirror our own instance.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { importVerifyKey, verifyRecordSig } from "./federation.js";

const now = () => Math.floor(Date.now() / 1000);
const MAX_PAGES = 50;

interface PeerRow {
  url: string; instance: string | null; public_key: string | null;
  caches_cursor: number; finds_cursor: number; keys_cursor: number; enabled: number;
}

interface FeedRecord { type: string; id: string; cursor: number; data: Record<string, unknown>; sig?: string; signer?: string }
interface Feed { instance: string; nextCursor: number; complete: boolean; items: FeedRecord[] }

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} <- ${url}`);
  return r.json() as Promise<T>;
}

function ours(env: Env): string | null { return env.INSTANCE ?? null; }

/** Seed fed_peers from the FED_PEERS env (idempotent), so config or the table can drive sync. */
async function seedPeers(env: Env): Promise<void> {
  const urls = (env.FED_PEERS ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  for (const url of urls) {
    await env.DB.prepare("INSERT OR IGNORE INTO fed_peers (url) VALUES (?)").bind(url).run();
  }
}

/** Seed from FED_PEERS then return the enabled peers (shared by sync + corroboration). */
export async function listEnabledPeers(env: Env): Promise<PeerRow[]> {
  await seedPeers(env);
  return (await env.DB.prepare("SELECT * FROM fed_peers WHERE enabled = 1").all<PeerRow>()).results;
}

export async function syncAllPeers(env: Env): Promise<{ peers: number; caches: number; finds: number; keys: number; errors: string[] }> {
  const peers = await listEnabledPeers(env);
  let caches = 0, finds = 0, keys = 0;
  const errors: string[] = [];
  for (const p of peers) {
    try {
      const r = await syncPeer(env, p);
      caches += r.caches; finds += r.finds; keys += r.keys;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${p.url}: ${msg}`);
      await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=? WHERE url=?").bind(msg, now(), p.url).run();
    }
  }
  return { peers: peers.length, caches, finds, keys, errors };
}

async function syncPeer(env: Env, p: PeerRow): Promise<{ caches: number; finds: number; keys: number }> {
  const base = p.url.replace(/\/+$/, "");
  const wk = await fetchJson<{ instance: string; signed: boolean; publicKey: string | null; peers?: string[] }>(`${base}/.well-known/aprscaching`);
  const pub = wk.signed ? wk.publicKey : null;
  await env.DB.prepare("UPDATE fed_peers SET instance=?, public_key=? WHERE url=?").bind(wk.instance ?? null, pub, p.url).run();

  // opt-in transitive discovery: adopt the peers this peer advertises (capped, deduped by INSERT OR IGNORE)
  if (env.FED_DISCOVER) {
    for (const url of (wk.peers ?? []).slice(0, 50)) {
      const u = String(url).trim().replace(/\/+$/, "");
      if (u && u !== base) await env.DB.prepare("INSERT OR IGNORE INTO fed_peers (url) VALUES (?)").bind(u).run();
    }
  }

  // never mirror ourselves
  if (wk.instance && wk.instance === ours(env)) return { caches: 0, finds: 0, keys: 0 };

  const verifyKey = pub ? await importVerifyKey(pub) : null;
  const caches = await syncCaches(env, base, p, wk.instance, verifyKey);
  const finds = await syncFinds(env, base, p, wk.instance, verifyKey);
  const keys = await syncKeys(env, base, p, wk.instance, verifyKey);
  await env.DB.prepare("UPDATE fed_peers SET last_sync=?, last_error=NULL WHERE url=?").bind(now(), p.url).run();
  return { caches, finds, keys };
}

async function accept(env: Env, rec: FeedRecord, verifyKey: CryptoKey | null): Promise<boolean> {
  if (verifyKey && !(await verifyRecordSig(verifyKey, rec))) return false; // bad signature
  if (rec.signer && rec.signer === ours(env)) return false;                // never mirror our own
  return true;
}

async function syncCaches(env: Env, base: string, p: PeerRow, instance: string, verifyKey: CryptoKey | null): Promise<number> {
  let cursor = p.caches_cursor, mirrored = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const feed = await fetchJson<Feed>(`${base}/federation/caches?since=${cursor}&limit=500`);
    for (const rec of feed.items ?? []) {
      if (!(await accept(env, rec, verifyKey))) continue;
      await upsertRemoteCache(env, rec, rec.signer ?? feed.instance ?? instance);
      mirrored++;
    }
    const next = feed.nextCursor ?? cursor;
    await env.DB.prepare("UPDATE fed_peers SET caches_cursor=? WHERE url=?").bind(next, p.url).run();
    if (feed.complete || next === cursor) break; // no further progress
    cursor = next;
  }
  return mirrored;
}

async function syncFinds(env: Env, base: string, p: PeerRow, instance: string, verifyKey: CryptoKey | null): Promise<number> {
  let cursor = p.finds_cursor, mirrored = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const feed = await fetchJson<Feed>(`${base}/federation/finds?since=${cursor}&limit=500`);
    for (const rec of feed.items ?? []) {
      if (!(await accept(env, rec, verifyKey))) continue;
      await upsertRemoteFind(env, rec, rec.signer ?? feed.instance ?? instance);
      mirrored++;
    }
    const next = feed.nextCursor ?? cursor;
    await env.DB.prepare("UPDATE fed_peers SET finds_cursor=? WHERE url=?").bind(next, p.url).run();
    if (feed.complete || next === cursor) break;
    cursor = next;
  }
  return mirrored;
}

async function syncKeys(env: Env, base: string, p: PeerRow, instance: string, verifyKey: CryptoKey | null): Promise<number> {
  let cursor = p.keys_cursor, mirrored = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const feed = await fetchJson<Feed>(`${base}/federation/keys?since=${cursor}&limit=500`);
    for (const rec of feed.items ?? []) {
      if (!(await accept(env, rec, verifyKey))) continue;
      await upsertRemoteKey(env, rec, rec.signer ?? feed.instance ?? instance);
      mirrored++;
    }
    const next = feed.nextCursor ?? cursor;
    await env.DB.prepare("UPDATE fed_peers SET keys_cursor=? WHERE url=?").bind(next, p.url).run();
    if (feed.complete || next === cursor) break;
    cursor = next;
  }
  return mirrored;
}

async function upsertRemoteKey(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO remote_keys (global_id, origin, callsign, public_key, verified, created_at, mirrored_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(rec.id, origin, d.callsign ?? null, d.publicKey ?? null, d.verified ? 1 : 0, d.createdAt ?? null, now()).run();
}

async function upsertRemoteCache(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO remote_caches
       (global_id, origin, code, owner_call, title, type, status, difficulty, terrain, lat, lon,
        station_call, source, external_id, hint, description, min_trust, created_at, updated_at, mirrored_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    rec.id, origin, d.code ?? null, d.ownerCall ?? null, d.title ?? null, d.type ?? null, d.status ?? null,
    d.difficulty ?? null, d.terrain ?? null, d.lat ?? null, d.lon ?? null, d.stationCall ?? null,
    d.source ?? null, d.externalId ?? null, d.hint ?? null, d.description ?? null, d.minTrust ?? null,
    d.createdAt ?? null, d.updatedAt ?? null, now(),
  ).run();
}

async function upsertRemoteFind(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO remote_finds
       (global_id, origin, cache_global_id, cache_code, logger_call, ts, log_type,
        verified, tier, verify_method, distance_m, comment, mirrored_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    rec.id, origin, d.cacheId ?? null, d.cacheCode ?? null, d.loggerCall ?? null, d.ts ?? null, d.logType ?? null,
    d.verified ? 1 : 0, d.tier ?? null, d.verifyMethod ?? null, d.distanceM ?? null, d.comment ?? null, now(),
  ).run();
}

// ---- endpoints ----
export async function handleFederationSync(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return new Response("unauthorized", { status: 401 });
  const summary = await syncAllPeers(env);
  return json({ ok: true, ...summary });
}

export async function handleFederationPeers(req: Request, env: Env): Promise<Response> {
  await seedPeers(env);
  const peers = (await env.DB.prepare(
    "SELECT url, instance, public_key IS NOT NULL AS signed, caches_cursor, finds_cursor, keys_cursor, enabled, last_sync, last_error FROM fed_peers ORDER BY url",
  ).all()).results;
  return json({ peers });
}
