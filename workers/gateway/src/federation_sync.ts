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

export type TrustLevel = "trusted" | "unvetted" | "blocked";
export const TRUST_LEVELS: readonly TrustLevel[] = ["trusted", "unvetted", "blocked"];

interface PeerRow {
  url: string; instance: string | null; public_key: string | null;
  caches_cursor: number; finds_cursor: number; keys_cursor: number; tombstones_cursor: number; enabled: number;
  trust: TrustLevel;
}

interface FeedRecord { type: string; id: string; cursor: number; data: Record<string, unknown>; sig?: string; signer?: string }
interface Feed { instance: string; nextCursor: number; complete: boolean; items: FeedRecord[] }

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} <- ${url}`);
  return r.json() as Promise<T>;
}

function ours(env: Env): string | null { return env.INSTANCE ?? null; }

/**
 * Seed fed_peers from the FED_PEERS env (idempotent). FED_PEERS are operator-curated, so they are
 * `manual` + `trusted` by definition (T1.1) — a manual peer the operator explicitly `blocked` stays
 * blocked (quarantine wins over re-seeding); `approved_at` is stamped once and preserved.
 */
async function seedPeers(env: Env): Promise<void> {
  const urls = (env.FED_PEERS ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  for (const url of urls) {
    await env.DB.prepare(
      `INSERT INTO fed_peers (url, trust, added_via, approved_at) VALUES (?, 'trusted', 'manual', ?)
       ON CONFLICT(url) DO UPDATE SET
         added_via   = 'manual',
         trust       = CASE WHEN fed_peers.trust = 'blocked' THEN 'blocked' ELSE 'trusted' END,
         approved_at = COALESCE(fed_peers.approved_at, excluded.approved_at)`,
    ).bind(url, now()).run();
  }
}

/**
 * Seed from FED_PEERS then return the **fetchable** peers — `enabled` and not `blocked` (quarantined
 * peers are never contacted, T1.1). Shared by sync (mirrors trusted + unvetted) and corroboration
 * (which further narrows to `trusted` only, T1.2).
 */
export async function listEnabledPeers(env: Env): Promise<PeerRow[]> {
  await seedPeers(env);
  return (await env.DB.prepare("SELECT * FROM fed_peers WHERE enabled = 1 AND trust != 'blocked'").all<PeerRow>()).results;
}

/**
 * Sync a single peer by its instance id — the gossip-ping target (T2.1). Only an enabled, non-blocked
 * peer we already follow is synced; the pull is signature-verified as usual. Returns whether it ran.
 */
export async function syncPeerByInstance(env: Env, instance: string): Promise<boolean> {
  await seedPeers(env);
  const p = await env.DB.prepare(
    "SELECT * FROM fed_peers WHERE instance = ? AND enabled = 1 AND trust != 'blocked' LIMIT 1",
  ).bind(instance).first<PeerRow>();
  if (!p) return false;
  try { await syncPeer(env, p); return true; }
  catch (e) {
    await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=? WHERE url=?").bind((e as Error).message, now(), p.url).run();
    return false;
  }
}

export async function syncAllPeers(env: Env): Promise<{ peers: number; caches: number; finds: number; keys: number; tombstones: number; errors: string[] }> {
  const peers = await listEnabledPeers(env);
  let caches = 0, finds = 0, keys = 0, tombstones = 0;
  const errors: string[] = [];
  for (const p of peers) {
    try {
      const r = await syncPeer(env, p);
      caches += r.caches; finds += r.finds; keys += r.keys; tombstones += r.tombstones;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${p.url}: ${msg}`);
      await env.DB.prepare("UPDATE fed_peers SET last_error=?, last_sync=? WHERE url=?").bind(msg, now(), p.url).run();
    }
  }
  return { peers: peers.length, caches, finds, keys, tombstones, errors };
}

async function syncPeer(env: Env, p: PeerRow): Promise<{ caches: number; finds: number; keys: number; tombstones: number }> {
  const base = p.url.replace(/\/+$/, "");
  const wk = await fetchJson<{ instance: string; signed: boolean; publicKey: string | null; peers?: string[] }>(`${base}/.well-known/aprscaching`);
  const pub = wk.signed ? wk.publicKey : null;
  await env.DB.prepare("UPDATE fed_peers SET instance=?, public_key=? WHERE url=?").bind(wk.instance ?? null, pub, p.url).run();

  // opt-in transitive discovery: adopt the peers this peer advertises (capped, deduped by INSERT OR IGNORE).
  // Discovered peers start `unvetted` — mirrored-but-flagged, excluded from corroboration until an
  // operator promotes them (T1.1). INSERT OR IGNORE never downgrades a peer already known/trusted.
  if (env.FED_DISCOVER) {
    for (const url of (wk.peers ?? []).slice(0, 50)) {
      const u = String(url).trim().replace(/\/+$/, "");
      if (u && u !== base)
        await env.DB.prepare("INSERT OR IGNORE INTO fed_peers (url, trust, added_via) VALUES (?, 'unvetted', 'discovered')").bind(u).run();
    }
  }

  // never mirror ourselves
  if (wk.instance && wk.instance === ours(env)) return { caches: 0, finds: 0, keys: 0, tombstones: 0 };

  const verifyKey = pub ? await importVerifyKey(pub) : null;
  // tombstones FIRST: a delete recorded before this pass suppresses re-mirroring of a stale record
  // that the caches/finds feeds might still hand us in the same sync (T1.3).
  const tombstones = await syncTombstones(env, base, p, wk.instance, verifyKey);
  const caches = await syncCaches(env, base, p, wk.instance, verifyKey);
  const finds = await syncFinds(env, base, p, wk.instance, verifyKey);
  const keys = await syncKeys(env, base, p, wk.instance, verifyKey);
  await env.DB.prepare("UPDATE fed_peers SET last_sync=?, last_error=NULL WHERE url=?").bind(now(), p.url).run();
  return { caches, finds, keys, tombstones };
}

/** A peer already tombstoned this global id — don't re-mirror it (T1.3 suppression). */
async function isTombstoned(env: Env, globalId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM remote_tombstones WHERE target_id = ?").bind(globalId).first<{ x: number }>());
}

async function accept(env: Env, rec: FeedRecord, verifyKey: CryptoKey | null): Promise<boolean> {
  if (verifyKey && !(await verifyRecordSig(verifyKey, rec))) return false; // bad signature
  if (rec.signer && rec.signer === ours(env)) return false;                // never mirror our own
  if (await isTombstoned(env, rec.id)) return false;                       // purged by a peer tombstone
  return true;
}

/**
 * Apply a peer's tombstone (T1.3): verify-then-purge. Deletes any mirrored cache/find whose global id
 * matches `targetId` (the global-id namespace makes kind unambiguous), and records it so the record
 * is never re-mirrored. PII-free — the tombstone carries only signed ids + a timestamp.
 */
async function applyTombstone(env: Env, rec: FeedRecord, origin: string): Promise<void> {
  const d = rec.data as { kind?: string; targetId?: string; ts?: number };
  const target = d.targetId;
  if (!target) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM remote_caches WHERE global_id = ?").bind(target),
    env.DB.prepare("DELETE FROM remote_finds WHERE global_id = ?").bind(target),
    env.DB.prepare("INSERT OR REPLACE INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at) VALUES (?,?,?,?,?)")
      .bind(target, origin, d.kind ?? "unknown", d.ts ?? now(), now()),
  ]);
}

async function syncTombstones(env: Env, base: string, p: PeerRow, instance: string, verifyKey: CryptoKey | null): Promise<number> {
  let cursor = p.tombstones_cursor, applied = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const feed = await fetchJson<Feed>(`${base}/federation/tombstones?since=${cursor}&limit=500`);
    for (const rec of feed.items ?? []) {
      if (!(await accept(env, rec, verifyKey))) continue;
      await applyTombstone(env, rec, rec.signer ?? feed.instance ?? instance);
      applied++;
    }
    const next = feed.nextCursor ?? cursor;
    await env.DB.prepare("UPDATE fed_peers SET tombstones_cursor=? WHERE url=?").bind(next, p.url).run();
    if (feed.complete || next === cursor) break;
    cursor = next;
  }
  return applied;
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
    `SELECT url, instance, public_key IS NOT NULL AS signed, trust, added_via, approved_at,
            rep_confirmed, rep_failed, caches_cursor, finds_cursor, keys_cursor, tombstones_cursor, enabled, last_sync, last_error
       FROM fed_peers ORDER BY url`,
  ).all()).results;
  return json({ peers });
}

/**
 * Operator control (T1.1): set a peer's trust level. INGEST_SECRET-gated (operator-only), so the
 * Workbench Settings → Federation surface can promote (`trusted`), demote (`unvetted`), or quarantine
 * (`blocked`) a peer. Promotion stamps `approved_at` once.
 */
export async function handlePeerTrust(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => null)) as { url?: string; trust?: string } | null;
  const trust = b?.trust as TrustLevel | undefined;
  if (!b?.url || !trust || !TRUST_LEVELS.includes(trust))
    return json({ ok: false, error: "url + trust (trusted|unvetted|blocked) required" }, { status: 400 });
  const url = b.url.trim().replace(/\/+$/, "");
  const exists = await env.DB.prepare("SELECT url FROM fed_peers WHERE url = ?").bind(url).first<{ url: string }>();
  if (!exists) return json({ ok: false, error: "unknown peer" }, { status: 404 });
  await env.DB.prepare(
    "UPDATE fed_peers SET trust = ?, approved_at = CASE WHEN ? = 'trusted' THEN COALESCE(approved_at, ?) ELSE approved_at END WHERE url = ?",
  ).bind(trust, trust, now(), url).run();
  return json({ ok: true, url, trust });
}
