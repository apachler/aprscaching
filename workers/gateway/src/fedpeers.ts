// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedpeers.ts — the peer table: trust levels, seeding from FED_PEERS and the signed registry, the keys
 * each origin's frames verify under, and the operator's peer endpoints: list, add by address, set trust
 * and remove.
 *
 * Every way in leaves a peer short of `trusted` until its sysop's key fingerprint has been compared: added
 * by address it starts `unvetted` with its key pinned, and raising it to `trusted` is a separate step; a
 * FED_PEERS entry starts `trusted` only when it pins the fingerprint its key then matches.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { nowS } from "./util/time.js";
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import {
  isInstanceId,
  keyFingerprint,
  loadRegistry,
  normalizeFingerprint,
  ownKeyFingerprint,
  parseAcceptKeys,
  parseFedPeers,
  registryKeyAllowed,
  usableKeys,
  type RegistryEntry,
} from "./federation.js";
import { forgetTransitPeer, requeueOrigin, supersedeTransitPeer } from "./fedtransit.js";

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
  caches_region?: string; // the region the caches cursor was read under ('' = the whole feed)
  transit_cursor?: number; // the transit feed cursor (fedtransit.ts)
  transit_region?: string; // the region the transit cursor was read under
  rotations?: string | null; // the peer's rotation records (JSON), handed on with its key
  bulletins_cursor_id?: number | null;
  enabled: number;
  trust: TrustLevel;
  added_via?: string;
  endpoints?: string | null; // typed endpoint set (JSON) — see fedtransport.ts
  accept_keys?: string | null; // verified key set (JSON [{x, until?}]) — see resolvePeerKeys
  verified_via?: string | null; // identity attestation, e.g. 'ardc-lot' (never a data-trust input)
  operator_call?: string | null; // the ARDC-verified base call of a 44net peer; the quorum's operator
  approved_at?: number | null; // when an operator (or a matching pinned fingerprint) first trusted it
  pinned_fingerprint?: string | null; // the key fingerprint a FED_PEERS entry pins (`<url>#<fingerprint>`)
  pin_matched_key?: string | null; // the key that pin matched; its verified successors keep matching it
  endpoints_source?: string | null; // where `endpoints` came from: dns | descriptor | announce
  auto_promoted_at?: number | null; // when corroboration raised it to trusted on its own
}

/**
 * The address of a peer row that blocks `instance`, or null. A block covers the instance, whatever address it
 * answers on, so every path that would bring a row for it to life asks here first.
 */
export async function blockedAt(env: Env, instance: string, exceptUrl?: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT url FROM fed_peers WHERE instance = ? AND trust = 'blocked' AND url != ? ORDER BY url LIMIT 1",
  )
    .bind(instance, exceptUrl ?? "")
    .first<{ url: string }>();
  return row?.url ?? null;
}

/** This instance's id — the namespace no peer may write into. */
export function ours(env: Env): string | null {
  return env.INSTANCE ?? null;
}

/**
 * Seed fed_peers from the FED_PEERS env (idempotent). A new entry starts `unvetted`, like a peer added in
 * Instance admin: a URL says where a peer is, not who holds its key. An entry that pins a key fingerprint
 * (`<url>#<fingerprint>`) records it, and the first sync whose key matches it raises the peer to `trusted`
 * (fedpull.ts). Re-seeding never changes a trust level the operator set, nor how the peer first arrived.
 */
export async function seedPeers(env: Env): Promise<void> {
  for (const { url, fingerprint } of parseFedPeers(env.FED_PEERS)) {
    await env.DB.prepare(
      `INSERT INTO fed_peers (url, trust, added_via, pinned_fingerprint) VALUES (?, 'unvetted', 'manual', ?)
       ON CONFLICT(url) DO UPDATE SET pinned_fingerprint = excluded.pinned_fingerprint`,
    )
      .bind(url, fingerprint)
      .run();
  }
  // registry discovery: seed peers from the verified signed registry as `unvetted` (operator
  // promotes). Carries the registry-bound key + instance so the anti-spoof check has them. No-op
  // unless FED_REGISTRY is configured + valid. INSERT OR IGNORE never downgrades a known peer, and an
  // instance blocked here under any address gets no new row.
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
        `INSERT OR IGNORE INTO fed_peers (url, instance, public_key, trust, added_via)
         SELECT ?, ?, ?, 'unvetted', 'registry'
          WHERE NOT EXISTS (SELECT 1 FROM fed_peers WHERE instance = ? AND trust = 'blocked')`,
      )
        .bind(u, e.instance, e.key ?? null, e.instance)
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
 * `"blocked"` when any row blocks it (a block covers every address), an empty set when the origin is
 * unknown — either way
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
      ORDER BY trust = 'blocked' DESC, url LIMIT 1`,
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
      `SELECT url, instance, public_key, public_key IS NOT NULL AS signed, trust, added_via, approved_at, auto_promoted_at,
            pinned_fingerprint, rep_confirmed, rep_failed, caches_cursor, finds_cursor, keys_cursor,
            tombstones_cursor, moves_cursor, enabled, last_sync, last_ok, last_error, sync_ok, sync_err,
            mirrored_total, last_counts,
            (SELECT MAX(m.submitted_at) FROM fed_submit_marks m WHERE m.instance = fed_peers.instance) AS last_push_in,
            (SELECT h.last_ok_at FROM fed_hub_status h WHERE h.hub = fed_peers.url) AS last_push_out
       FROM fed_peers ORDER BY url`,
    ).all<Record<string, unknown> & { public_key: string | null; url: string }>()
  ).results;
  const configured = new Set(parseFedPeers(env.FED_PEERS).map((p) => p.url));
  // derive a health signal + error rate so an operator scans state without doing the math.
  const peers = await Promise.all(
    rows.map(async ({ public_key, ...p }) => {
      const okN = Number(p.sync_ok ?? 0),
        errN = Number(p.sync_err ?? 0);
      const lastErrored = !!p.last_error && (!p.last_ok || Number(p.last_sync ?? 0) > Number(p.last_ok ?? 0));
      const health = p.trust === "blocked" ? "blocked" : !p.last_sync ? "new" : lastErrored ? "error" : "ok";
      return {
        ...p,
        fingerprint: await keyFingerprint(public_key),
        configured: configured.has(p.url), // listed in FED_PEERS: removed there, not here
        lastCounts: p.last_counts ? JSON.parse(p.last_counts as string) : null,
        errorRate: okN + errN > 0 ? errN / (okN + errN) : 0,
        health,
      };
    }),
  );
  return json({ self: { instance: ours(env), fingerprint: await ownKeyFingerprint(env) }, peers });
}

/** A descriptor fetch gives up after this long. */
const DESCRIPTOR_TIMEOUT_MS = 8000;
/** Largest descriptor read when adding a peer. */
const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const RAW_KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding

/** What adding a peer shows its sysop before anything is stored. */
interface PeerPreview {
  url: string;
  instance: string;
  fingerprint: string;
  operator: string | null;
}

class PeerAddRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly preview?: PeerPreview,
  ) {
    super(message);
  }
}

/** A peer's base URL as typed: http(s), no credentials, query or fragment, without trailing slashes. */
function peerBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash)
    return null;
  return trimTrailingSlashes(`${u.origin}${u.pathname}`);
}

/** Fetch a would-be peer's descriptor and read who it says it is and the key it signs with. */
async function lookUpPeer(
  env: Env,
  url: string,
): Promise<{ instance: string; publicKey: string; operator: string | null }> {
  let res: Response;
  try {
    res = await fedFetch(env, `${url}/.well-known/aprscaching`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DESCRIPTOR_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PeerAddRefused(`${url} did not answer: ${(e as Error).message}`, 502);
  }
  if (!res.ok) throw new PeerAddRefused(`${url} answered ${res.status} for its federation descriptor`, 502);
  const body = await readCappedBody(res, MAX_DESCRIPTOR_BYTES);
  type Descriptor = { instance?: unknown; signed?: unknown; publicKey?: unknown; operator?: unknown };
  let wk: Descriptor | null;
  try {
    wk = body ? (JSON.parse(new TextDecoder().decode(body)) as Descriptor | null) : null;
  } catch {
    wk = null;
  }
  if (!wk || typeof wk !== "object") throw new PeerAddRefused(`${url} serves no federation descriptor`, 502);
  if (!isInstanceId(wk.instance)) throw new PeerAddRefused(`${url} names an invalid instance id`, 502);
  if (wk.signed !== true || typeof wk.publicKey !== "string" || !RAW_KEY_RE.test(wk.publicKey))
    throw new PeerAddRefused(`${wk.instance} publishes no signing key, so nothing it serves could be verified`, 409);
  return {
    instance: wk.instance,
    publicKey: wk.publicKey,
    operator: typeof wk.operator === "string" ? wk.operator : null,
  };
}

/**
 * POST /federation/peers — add a peer by its address. Sysop-only. Body `{ url, fingerprint? }`.
 *
 * Without `fingerprint` it only looks the peer up: it fetches the peer's descriptor and answers with its
 * instance id, URL and key fingerprint, for the sysop to compare with the other sysop. With the fingerprint
 * that look-up showed, it adds the peer `unvetted` with that key pinned; a key that changed in between is
 * refused, so the key stored is the one compared. A peer is never trusted on add: that is the trust
 * endpoint's job, asked for separately.
 */
export async function handlePeerAdd(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const b = (await req.json().catch(() => null)) as { url?: unknown; fingerprint?: unknown } | null;
  const url = peerBaseUrl(b?.url);
  if (!url)
    return json({ error: "url must be the peer's http(s) base URL, e.g. https://aprs.example.net" }, { status: 400 });
  try {
    const listed = await env.DB.prepare("SELECT trust FROM fed_peers WHERE url = ?")
      .bind(url)
      .first<{ trust: string }>();
    if (listed) throw new PeerAddRefused(`${url} is already a peer (${listed.trust}): change its trust instead`, 409);
    const d = await lookUpPeer(env, url);
    if (d.instance === ours(env)) throw new PeerAddRefused(`${url} is this instance`, 400);
    const fingerprint = await keyFingerprint(d.publicKey);
    if (!fingerprint) throw new PeerAddRefused(`${d.instance} publishes a malformed signing key`, 409);
    const preview: PeerPreview = {
      url,
      instance: d.instance,
      fingerprint,
      operator: d.operator,
    };
    // one row per instance id: a second URL for a known instance is a stale address or an impostor, and a
    // blocked instance stays blocked under any address. A key a hub handed on gives way to the peer's own.
    const holder = await env.DB.prepare(
      "SELECT url, trust, added_via FROM fed_peers WHERE instance = ? ORDER BY trust = 'blocked' DESC LIMIT 1",
    )
      .bind(d.instance)
      .first<{ url: string; trust: TrustLevel; added_via: string | null }>();
    if (holder && (holder.added_via !== "transit" || holder.trust === "blocked"))
      throw new PeerAddRefused(
        holder.trust === "blocked"
          ? `${d.instance} is blocked here (at ${holder.url}): remove that peer first to add it again`
          : `${d.instance} is already a peer at ${holder.url}: remove that peer first to move it`,
        409,
        preview,
      );
    let registry: Map<string, RegistryEntry>;
    try {
      registry = await loadRegistry(env);
    } catch {
      throw new PeerAddRefused("the federation registry is misconfigured on this instance", 503);
    }
    if (!registryKeyAllowed(registry.get(d.instance), d.publicKey))
      throw new PeerAddRefused(`${d.instance} signs with a key the registry does not bind to it`, 409, preview);
    if (b?.fingerprint === undefined) return json({ preview });
    if ((typeof b.fingerprint === "string" ? normalizeFingerprint(b.fingerprint) : null) !== preview.fingerprint)
      throw new PeerAddRefused(
        `${d.instance}'s key is not the one you compared: look it up again and compare the new fingerprint`,
        409,
        preview,
      );
    await supersedeTransitPeer(env, d.instance, [d.publicKey]);
    try {
      await env.DB.prepare(
        `INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via, enabled)
         VALUES (?, ?, ?, ?, 'unvetted', 'admin', 1)`,
      )
        .bind(url, d.instance, d.publicKey, JSON.stringify([{ x: d.publicKey }]))
        .run();
    } catch (e) {
      if (/UNIQUE|constraint/i.test((e as Error).message))
        throw new PeerAddRefused(`${d.instance} was added meanwhile`, 409, preview);
      throw e;
    }
    return json({ ok: true, peer: { ...preview, trust: "unvetted" } }, { status: 201 });
  } catch (e) {
    if (e instanceof PeerAddRefused)
      return json({ error: e.message, ...(e.preview && { preview: e.preview }) }, { status: e.status });
    throw e;
  }
}

/**
 * DELETE /federation/peers?url=<url> — remove a peer and its pinned key. Sysop-only. A peer listed in
 * FED_PEERS comes back at the next seeding, so it is taken out of FED_PEERS first.
 *
 * What the peer published stays mirrored and is treated like anything from an unknown origin: hidden on the
 * map and in offline packs unless the viewer includes unvetted peers, and never a corroborating voice. An
 * origin known only through a hub (a `transit:` row) is the exception: its key came from that hub, so the
 * records it vouched for go with it. No
 * frame of its applies until it is added again, and then it starts `unvetted` with its key fetched and
 * compared afresh. Blocking, not removing, is what hides everything it published.
 */
export async function handlePeerRemove(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const url = trimTrailingSlashes((new URL(req.url).searchParams.get("url") ?? "").trim());
  if (!url) return json({ error: "url required" }, { status: 400 });
  const row = await env.DB.prepare("SELECT url, instance, added_via FROM fed_peers WHERE url = ?")
    .bind(url)
    .first<{ url: string; instance: string | null; added_via: string | null }>();
  if (!row) return json({ error: "unknown peer" }, { status: 404 });
  if (parseFedPeers(env.FED_PEERS).some((p) => p.url === url))
    return json(
      { error: `${url} is listed in FED_PEERS: take it out there and restart the gateway, then remove it here` },
      { status: 409 },
    );
  await env.DB.prepare("DELETE FROM fed_peers WHERE url = ?").bind(url).run();
  // a spoke that pushed here: its marks go too, so it starts over as a new spoke if it pushes again
  if (row.instance && url === `submit:${row.instance}`)
    await env.DB.prepare("DELETE FROM fed_submit_marks WHERE instance = ?").bind(row.instance).run();
  // an origin known only through a hub: what that hub's key vouched for goes with the key
  if (row.instance && row.added_via === "transit") await forgetTransitPeer(env, row.instance);
  return json({ ok: true, url });
}

/**
 * Operator control: set a peer's trust level. Sysop-only (signed-in instance operator) or the
 * operator secret, so the operator's Instance-admin → Federation surface can promote (`trusted`), demote
 * (`unvetted`), or quarantine (`blocked`) a peer. Promotion stamps `approved_at` once; any decision here
 * replaces an automatic promotion.
 *
 * `trusted` needs a pinned key and the `fingerprint` the sysop compared, on every path: until a peer's key is
 * known there is no fingerprint to compare, trusting it would trust whichever key answers first, and a key that
 * moved since the comparison is refused.
 *
 * A block covers the instance: every row naming it is blocked with it. Lifting it on one row is refused while
 * another row still blocks the instance, so the sysop removes the stale address first.
 */
export async function handlePeerTrust(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const b = (await req.json().catch(() => null)) as { url?: string; trust?: string; fingerprint?: unknown } | null;
  const trust = b?.trust as TrustLevel | undefined;
  if (typeof b?.url !== "string" || !trust || !TRUST_LEVELS.includes(trust))
    return json({ ok: false, error: "url + trust (trusted|unvetted|blocked) required" }, { status: 400 });
  const url = trimTrailingSlashes(b.url.trim());
  const exists = await env.DB.prepare("SELECT url, instance, public_key FROM fed_peers WHERE url = ?")
    .bind(url)
    .first<{ url: string; instance: string | null; public_key: string | null }>();
  if (!exists) return json({ ok: false, error: "unknown peer" }, { status: 404 });
  if (trust === "trusted") {
    if (!exists.public_key)
      return json(
        {
          ok: false,
          error:
            "no key is pinned for this peer yet: let it sync as unvetted, then compare its fingerprint and trust it",
        },
        { status: 409 },
      );
    if (b.fingerprint === undefined)
      return json(
        { ok: false, error: "fingerprint required: compare the peer's key fingerprint with its sysop, then send it" },
        { status: 400 },
      );
    if (
      (typeof b.fingerprint === "string" ? normalizeFingerprint(b.fingerprint) : null) !==
      (await keyFingerprint(exists.public_key))
    )
      return json(
        { ok: false, error: "the peer's pinned key is not the one you compared: reload and compare again" },
        { status: 409 },
      );
  }
  if (trust !== "blocked" && exists.instance) {
    const other = await blockedAt(env, exists.instance, url);
    if (other)
      return json(
        { ok: false, error: `${exists.instance} is blocked here at ${other} as well: remove that peer first` },
        { status: 409 },
      );
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        // choosing a level for a discovered peer (which starts disabled) is the operator enabling it
        `UPDATE fed_peers SET trust = ?, auto_promoted_at = NULL,
           approved_at = CASE WHEN ? = 'trusted' THEN COALESCE(approved_at, ?) ELSE approved_at END,
           enabled = CASE WHEN added_via = 'discovered' AND ? != 'blocked' THEN 1 ELSE enabled END
         WHERE url = ?`,
      ).bind(trust, trust, nowS(), trust, url),
      // a block covers the instance under every address it is known by
      ...(trust === "blocked" && exists.instance
        ? [
            env.DB.prepare(
              "UPDATE fed_peers SET trust = 'blocked', auto_promoted_at = NULL WHERE instance = ? AND url != ?",
            ).bind(exists.instance, url),
          ]
        : []),
    ]);
  } catch (e) {
    // unblocking a row whose instance id another live row already holds
    if (/UNIQUE/i.test((e as Error).message))
      return json(
        { ok: false, error: "another peer holds this instance id — block or remove it first" },
        { status: 409 },
      );
    throw e;
  }
  // records held back while the origin was not trusted (or blocked) go out on the transit feed now
  if (trust !== "blocked") await requeueOrigin(env, exists.instance);
  return json({ ok: true, url, trust });
}
