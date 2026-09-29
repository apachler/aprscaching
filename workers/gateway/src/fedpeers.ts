// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedpeers.ts — the peer table: trust levels, seeding from FED_PEERS and the signed registry, the keys
 * each origin's frames verify under, and the operator's peer and trust endpoints.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { nowS } from "./util/time.js";
import { trimTrailingSlashes } from "./fetchguard.js";
import { isInstanceId, loadRegistry, parseAcceptKeys, usableKeys, type RegistryEntry } from "./federation.js";

export type TrustLevel = "trusted" | "unvetted" | "blocked";
export const TRUST_LEVELS: readonly TrustLevel[] = ["trusted", "unvetted", "blocked"];

export interface PeerRow {
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

/** This instance's id — the namespace no peer may write into. */
export function ours(env: Env): string | null {
  return env.INSTANCE ?? null;
}

/**
 * Seed fed_peers from the FED_PEERS env (idempotent). FED_PEERS are operator-curated, so they are
 * `manual` + `trusted` by definition — a manual peer the operator explicitly `blocked` stays
 * blocked (quarantine wins over re-seeding); `approved_at` is stamped once and preserved.
 */
export async function seedPeers(env: Env): Promise<void> {
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
      .bind(url, nowS())
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
 * The keys a claimed origin's frames may be signed under: the key set last verified for its live
 * peer row (the pin plus predecessors inside their rotation grace, see resolvePeerKeys) plus the key
 * the signed registry binds to its instance id. An instance has at most one live (non-blocked) row;
 * `"blocked"` when only blocked rows name it, an empty set when the origin is unknown — either way
 * its frames never apply. A disabled row (never pulled, such as a push-to-hub spoke) still names its
 * keys: `enabled` decides whether we fetch from a peer, not who it is.
 */
export async function originKeys(
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
    if (accept.length) for (const k of usableKeys(accept, nowS())) keys.add(k);
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
      .bind(trust, trust, nowS(), trust, url)
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
