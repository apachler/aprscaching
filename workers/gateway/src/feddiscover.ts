// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * feddiscover.ts — how an instance hears of instances it has not added: peer exchange and mDNS.
 *
 *   GET  /federation/exchange          the instances this one trusts: id, key fingerprint, typed addresses (JSON)
 *   POST /federation/peers/follow      sysop: follow a discovered instance, optionally trusting it at once
 *
 * Peer exchange. An instance lists the peers it trusts, never one it has blocked, unless its sysop turns the
 * list off (FED_PEER_EXCHANGE). With FED_DISCOVER on, a pull from a TRUSTED peer reads that peer's list at most
 * once an hour; what an unvetted or blocked peer lists is never read.
 *
 * mDNS. On a Pocket or Desktop instance the server listens for `_aprscaching._tcp` announcements on the local
 * network (servers/node mdns.ts) and hands each one here: the instance id and fingerprint from its TXT record,
 * and the address that announced it.
 *
 * Either way, what is learned is a sighting on the instance's one peer row, and a new instance is listed,
 * switched off and unvetted: a `discovered:<instance>` row that is never pulled, and anything of its that reaches
 * this instance through a hub stays hidden like any unvetted origin's, until the sysop follows and trusts it. A sighting never sets or moves a key: a fingerprint that
 * differs from the pinned key's, or two sources that disagree, is shown in Instance admin and the pin stays.
 * An instance a hub already passes records on for (a `transit:` row) takes the sighting on that row, so the
 * two never become two rows; a `discovered:` row whose origin a hub later names becomes that `transit:` row.
 *
 * Bounds: at most MAX_DISCOVERED unfollowed rows, at most MAX_LISTED entries read from one list, and a sighting
 * lasts while its source keeps naming the instance — PEER_SIGHTING_TTL_S for a peer's list, as long as that
 * peer stays trusted, MDNS_SIGHTING_TTL_S for an announcement. The nightly job drops older sightings and an
 * unfollowed row left with none.
 *
 * Follow fetches the instance's descriptor at the addresses learned, checks that it answers as the instance
 * listed, with a key whose fingerprint every source gave and, for a `transit:` row, the key already pinned; then
 * the row becomes a normal enabled peer at the address that answered, unvetted, or trusted when the sysop
 * compared the fingerprint and asked for it.
 */
import type { Env } from "./env.js";
import { json } from "./http.js";
import { requireSysop } from "./admin.js";
import { nowS } from "./util/time.js";
import { setting } from "./siteconfig.js";
import { isLocalHost, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import {
  instanceOf,
  isInstanceId,
  keyFingerprint,
  loadRegistry,
  normalizeFingerprint,
  registryKeyAllowed,
  type RegistryEntry,
} from "./federation.js";
import {
  mergeEndpoints,
  peerEndpoints,
  storedEndpoints,
  syncAddresses,
  type FedSyncTransport,
} from "./fedtransport.js";
import {
  DISCOVERED_PREFIX,
  PeerAddRefused,
  blockedAt,
  lookUpPeer,
  ours,
  parseSightings,
  type PeerRow,
  type Sighting,
} from "./fedpeers.js";
import { endpointBaseUrls, parseEndpoints, type FedEndpoint } from "@aprscaching/shared";

/** The descriptor capability of an instance that serves its peer list. */
export const PEER_EXCHANGE_CAPABILITY = "peer-exchange";
/** Where the peer list is served. */
export const PEER_EXCHANGE_PATH = "/federation/exchange";
/** The `via` of a sighting from an mDNS announcement. */
const MDNS = "mdns";
/** Unfollowed discovered rows: discovery adds no row past this many. */
const MAX_DISCOVERED = 200;
/** Entries one list serves, and the most read from one. */
const MAX_LISTED = 200;
/** Addresses kept per listed instance. */
const MAX_ADDRESSES = 16;
/** Sightings kept per row, newest first. */
const MAX_SIGHTINGS = 8;
/** A peer list's sighting lasts this long without the peer naming the instance again. */
const PEER_SIGHTING_TTL_S = 14 * 86400;
/** An mDNS sighting lasts this long without another announcement. */
const MDNS_SIGHTING_TTL_S = 86400;
/** A trusted peer's list is read at most this often. */
const EXCHANGE_EVERY_MS = 3600_000;
/** An mDNS announcement of one instance is recorded at most this often. */
const MDNS_RECORD_EVERY_MS = 60_000;
/** Largest peer list read. */
const MAX_EXCHANGE_BYTES = 512 * 1024;

/** FED_PEER_EXCHANGE: on unless set to 0, false or no. */
/** FED_DISCOVER: on unless set to 0/false/no, since a learned instance waits switched off until the sysop follows it. */
export function discoverOn(env: Env): boolean {
  return !/^(0|false|no)$/i.test((env.FED_DISCOVER ?? "").trim());
}

export function peerExchangeOn(env: Env): boolean {
  return !/^(0|false|no)$/i.test((setting(env, "FED_PEER_EXCHANGE") ?? "").trim());
}

/** One instance as a peer list names it. */
interface ListedPeer {
  instance: string;
  fingerprint: string;
  addresses: FedEndpoint[];
}

/** Whether an endpoint is reached on a LAN or loopback address: such an address means nothing to a peer. */
function localEndpoint(e: FedEndpoint): boolean {
  return endpointBaseUrls(e).some((u) => {
    try {
      return isLocalHost(new URL(u).hostname);
    } catch {
      return true;
    }
  });
}

/** The addresses of a peer row worth handing on: its endpoint set and url, less LAN and loopback ones. */
function listedAddresses(row: { url: string; endpoints: string | null }): FedEndpoint[] {
  return peerEndpoints(row)
    .filter((e) => !localEndpoint(e))
    .slice(0, MAX_ADDRESSES)
    .map((e) => ({ transport: e.transport, address: e.address, priority: e.priority }));
}

/** GET /federation/exchange — the instances this one trusts. 404 while FED_PEER_EXCHANGE is off. */
export async function handlePeerExchange(req: Request, env: Env): Promise<Response> {
  if (!peerExchangeOn(env)) return json({ error: "this instance lists no peers" }, { status: 404 });
  const rows = (
    await env.DB.prepare(
      `SELECT url, instance, public_key, endpoints FROM fed_peers p
        WHERE trust = 'trusted' AND instance IS NOT NULL AND public_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fed_peers b WHERE b.instance = p.instance AND b.trust = 'blocked')
        ORDER BY instance LIMIT ?`,
    )
      .bind(MAX_LISTED)
      .all<{ url: string; instance: string; public_key: string; endpoints: string | null }>()
  ).results;
  const peers: ListedPeer[] = [];
  for (const r of rows) {
    const addresses = listedAddresses(r);
    const fingerprint = await keyFingerprint(r.public_key);
    if (addresses.length && fingerprint) peers.push({ instance: r.instance, fingerprint, addresses });
  }
  return json({ instance: instanceOf(req, env), peers });
}

/** Add or refresh one source's sighting, newest first; one sighting per source. */
function withSighting(list: Sighting[], s: Sighting): Sighting[] {
  return [s, ...list.filter((x) => x.via !== s.via)].sort((a, b) => b.at - a.at).slice(0, MAX_SIGHTINGS);
}

/**
 * Record that `s.via` names `instance`, with the addresses it gave. Annotates the instance's row when it has
 * one; otherwise adds an unfollowed `discovered:` row, within the cap. A blocked instance is skipped.
 */
async function sight(env: Env, instance: string, s: Sighting, addresses: FedEndpoint[]): Promise<void> {
  if (await blockedAt(env, instance)) return;
  const row = await env.DB.prepare(
    `SELECT url, added_via, endpoints, endpoints_source, discovered FROM fed_peers
      WHERE instance = ? AND trust != 'blocked' LIMIT 1`,
  )
    .bind(instance)
    .first<Pick<PeerRow, "url" | "added_via" | "endpoints" | "endpoints_source" | "discovered">>();
  const sightings = JSON.stringify(withSighting(parseSightings(row?.discovered), s));
  if (row) {
    // addresses are learned only for a row with none of its own: a discovered row, or an origin known through a
    // hub; a peer's own descriptor and DNS stay the authority on where it is
    const learn =
      addresses.length > 0 &&
      (row.url.startsWith(DISCOVERED_PREFIX) ||
        (row.added_via === "transit" && row.endpoints_source !== "descriptor" && row.endpoints_source !== "dns"));
    const endpoints = learn
      ? JSON.stringify(mergeEndpoints(storedEndpoints(row.endpoints), addresses, { replace: false }))
      : (row.endpoints ?? null);
    await env.DB.prepare(
      `UPDATE fed_peers SET discovered = ?, listed_at = MAX(COALESCE(listed_at, 0), ?), endpoints = ?,
         endpoints_source = CASE WHEN ? THEN 'discovered' ELSE endpoints_source END
       WHERE url = ?`,
    )
      .bind(sightings, s.at, endpoints, learn ? 1 : 0, row.url)
      .run();
    return;
  }
  const have =
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM fed_peers WHERE url LIKE '${DISCOVERED_PREFIX}%' AND trust != 'blocked'`,
      ).first<{ n: number }>()
    )?.n ?? 0;
  if (have >= MAX_DISCOVERED) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO fed_peers (url, instance, trust, added_via, enabled, endpoints, endpoints_source, discovered, listed_at)
     VALUES (?, ?, 'unvetted', 'discovered', 0, ?, ?, ?, ?)`,
  )
    .bind(
      `${DISCOVERED_PREFIX}${instance}`,
      instance,
      addresses.length ? JSON.stringify(mergeEndpoints([], addresses, { replace: false })) : null,
      addresses.length ? "discovered" : null,
      sightings,
      s.at,
    )
    .run();
}

/**
 * Record what a trusted peer's list names. Each entry needs a valid instance id, a fingerprint and at least one
 * address that is not on a LAN; this instance and the listing peer itself are skipped.
 */
export async function learnListing(env: Env, via: string, list: unknown): Promise<number> {
  if (!Array.isArray(list)) return 0;
  const us = ours(env);
  const at = nowS();
  let learned = 0;
  for (const raw of list.slice(0, MAX_LISTED)) {
    const e = raw as Partial<Record<keyof ListedPeer, unknown>> | null;
    if (!e || !isInstanceId(e.instance) || e.instance === us || e.instance === via) continue;
    const fp = typeof e.fingerprint === "string" ? normalizeFingerprint(e.fingerprint) : null;
    if (!fp) continue;
    const addresses = parseEndpoints(e.addresses)
      .filter((a) => !localEndpoint(a))
      .slice(0, MAX_ADDRESSES);
    if (!addresses.length) continue;
    await sight(env, e.instance, { via, fp, at }, addresses);
    learned++;
  }
  return learned;
}

const lastExchange = new WeakMap<object, Map<string, number>>();

/**
 * After a pull from `p`: read its peer list when discovery is on, the peer is trusted and serves one, at most
 * once an hour per peer. A list that cannot be read is skipped; the pull it rode on stands.
 */
export async function learnFromPeer(
  env: Env,
  transport: FedSyncTransport,
  p: Pick<PeerRow, "url" | "trust">,
  wk: { instance: string; capabilities?: string[] },
): Promise<void> {
  if (!discoverOn(env) || p.trust !== "trusted") return;
  if (!(wk.capabilities ?? []).includes(PEER_EXCHANGE_CAPABILITY)) return;
  let seen = lastExchange.get(env);
  if (!seen) lastExchange.set(env, (seen = new Map()));
  const last = seen.get(p.url);
  if (last !== undefined && Date.now() - last < EXCHANGE_EVERY_MS) return;
  seen.set(p.url, Date.now());
  try {
    const res = await transport.get(PEER_EXCHANGE_PATH);
    if (!res.ok) return;
    const body = await readCappedBody(res, MAX_EXCHANGE_BYTES);
    if (!body) return;
    const doc = JSON.parse(new TextDecoder().decode(body)) as { peers?: unknown } | null;
    await learnListing(env, wk.instance, doc?.peers);
  } catch (e) {
    console.warn(`federation: the peer list of ${wk.instance} was not read: ${(e as Error).message}`);
  }
}

/** One instance an mDNS announcement names (servers/node mdns.ts). */
interface LanAnnouncement {
  instance: string;
  fingerprint: string;
  /** The base URL the instance answers on: the address that announced it, the port and the path prefix. */
  address: string;
}

const lastLan = new WeakMap<object, Map<string, number>>();

/** The base URL of an announced address: http(s), no credentials, query or fragment. Null otherwise. */
function lanBase(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash)
    return null;
  return trimTrailingSlashes(`${u.origin}${u.pathname}`);
}

/** Record an instance heard on the local network. Returns whether the announcement was taken. */
export async function recordLanSighting(env: Env, a: LanAnnouncement): Promise<boolean> {
  if (!isInstanceId(a.instance) || a.instance === ours(env)) return false;
  const fp = normalizeFingerprint(a.fingerprint);
  const addr = lanBase(a.address);
  if (!fp || !addr) return false;
  let seen = lastLan.get(env);
  if (!seen) lastLan.set(env, (seen = new Map()));
  const key = `${a.instance} ${fp} ${addr}`;
  const last = seen.get(key);
  if (last !== undefined && Date.now() - last < MDNS_RECORD_EVERY_MS) return false;
  seen.set(key, Date.now());
  if (seen.size > MAX_DISCOVERED * 2) seen.delete(seen.keys().next().value as string);
  await sight(env, a.instance, { via: MDNS, fp, at: nowS(), addr }, []);
  return true;
}

/**
 * Whether a federation fetch may reach `origin` on a private address because mDNS found an instance there: an
 * unfollowed row announced from it, or a peer the sysop followed from such an announcement. Nothing else on the
 * LAN becomes reachable through this.
 */
export async function lanOriginAllowed(env: Env, origin: string): Promise<boolean> {
  const rows = (
    await env.DB.prepare(
      `SELECT url, added_via, enabled, discovered FROM fed_peers
        WHERE trust != 'blocked' AND (added_via = 'mdns' OR discovered LIKE '%"via":"mdns"%')`,
    ).all<{ url: string; added_via: string | null; enabled: number; discovered: string | null }>()
  ).results;
  const originOf = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  };
  return rows.some(
    (r) =>
      (r.added_via === "mdns" && Number(r.enabled) === 1 && originOf(r.url) === origin) ||
      (r.url.startsWith(DISCOVERED_PREFIX) &&
        parseSightings(r.discovered).some((s) => s.via === MDNS && s.addr && originOf(s.addr) === origin)),
  );
}

/**
 * The nightly pass: drop sightings past their lifetime and those of a peer no longer trusted, then the
 * unfollowed rows left with none. Returns how many rows went.
 */
export async function expireDiscovered(env: Env): Promise<number> {
  const now = nowS();
  const trusted = new Set(
    (
      await env.DB.prepare("SELECT instance FROM fed_peers WHERE trust = 'trusted' AND instance IS NOT NULL").all<{
        instance: string;
      }>()
    ).results.map((r) => r.instance),
  );
  const rows = (
    await env.DB.prepare("SELECT url, trust, discovered FROM fed_peers WHERE discovered IS NOT NULL").all<{
      url: string;
      trust: string;
      discovered: string;
    }>()
  ).results;
  let removed = 0;
  for (const r of rows) {
    const all = parseSightings(r.discovered);
    const keep = all.filter((s) =>
      s.via === MDNS ? now - s.at < MDNS_SIGHTING_TTL_S : now - s.at < PEER_SIGHTING_TTL_S && trusted.has(s.via),
    );
    if (!keep.length && r.url.startsWith(DISCOVERED_PREFIX) && r.trust !== "blocked") {
      await env.DB.prepare("DELETE FROM fed_peers WHERE url = ?").bind(r.url).run();
      removed++;
    } else if (keep.length !== all.length)
      await env.DB.prepare("UPDATE fed_peers SET discovered = ?, listed_at = ? WHERE url = ?")
        .bind(keep.length ? JSON.stringify(keep) : null, keep.length ? keep[0]!.at : null, r.url)
        .run();
  }
  return removed;
}

/**
 * POST /federation/peers/follow — follow a discovered instance. Sysop-only. Body `{ url, trust?, fingerprint? }`:
 * `url` is the row in Instance admin's Discovered group. `trust: true` trusts it at once and needs the
 * `fingerprint` the sysop compared with the other sysop.
 */
export async function handlePeerFollow(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const b = (await req.json().catch(() => null)) as { url?: unknown; trust?: unknown; fingerprint?: unknown } | null;
  if (typeof b?.url !== "string") return json({ error: "url required" }, { status: 400 });
  const row = await env.DB.prepare("SELECT * FROM fed_peers WHERE url = ?").bind(b.url).first<PeerRow>();
  if (!row?.instance) return json({ error: "unknown discovered instance" }, { status: 404 });
  const sightings = parseSightings(row.discovered);
  const followable = row.url.startsWith(DISCOVERED_PREFIX) || (row.added_via === "transit" && sightings.length > 0);
  if (!followable || row.trust === "blocked")
    return json({ error: `${row.instance} is not a discovered instance waiting to be followed` }, { status: 409 });
  const wantTrust = b.trust === true;
  try {
    // the addresses learned: an announcement on this network first, then what peers listed
    const lan = sightings.filter((s) => s.via === MDNS && s.addr).map((s) => s.addr!);
    const listed = syncAddresses({ endpoints: row.endpoints }).map((a) => a.baseUrl);
    const candidates = [...new Set([...lan, ...listed])];
    if (!candidates.length) throw new PeerAddRefused(`no address is known for ${row.instance}`, 409);
    let found: { url: string; publicKey: string; instance: string; operator: string | null } | null = null;
    const errors: string[] = [];
    for (const url of candidates) {
      try {
        found = { url, ...(await lookUpPeer(env, url)) };
        break;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (!found) throw new PeerAddRefused(errors.join("; "), 502);
    if (found.instance !== row.instance)
      throw new PeerAddRefused(`${found.url} answers as ${found.instance}, not ${row.instance}`, 409);
    const fingerprint = (await keyFingerprint(found.publicKey))!;
    const preview = { url: found.url, instance: row.instance, fingerprint, operator: found.operator };
    let registry: Map<string, RegistryEntry>;
    try {
      registry = await loadRegistry(env);
    } catch {
      throw new PeerAddRefused("the federation registry is misconfigured on this instance", 503);
    }
    if (!registryKeyAllowed(registry.get(row.instance), found.publicKey))
      throw new PeerAddRefused(`${row.instance} signs with a key the registry does not bind to it`, 409, preview);
    // the pin stays: a hub's key for this origin is not replaced by following it
    if (row.public_key && row.public_key !== found.publicKey)
      throw new PeerAddRefused(
        `${row.instance} serves a key other than the one pinned here; the pin stays. Compare fingerprints with ` +
          "its sysop, then remove this entry and add the instance by its address",
        409,
        preview,
      );
    const other = sightings.filter((s) => s.fp && s.fp !== fingerprint);
    if (other.length)
      throw new PeerAddRefused(
        `${row.instance} serves the key ${fingerprint}, but ${other.map((s) => `${s.via} listed ${s.fp}`).join(", ")}. ` +
          "Compare fingerprints with its sysop before adding it by its address",
        409,
        preview,
      );
    if (wantTrust) {
      const compared = typeof b.fingerprint === "string" ? normalizeFingerprint(b.fingerprint) : null;
      if (compared !== fingerprint)
        throw new PeerAddRefused(
          compared
            ? `${row.instance}'s key is not the one you compared: compare the new fingerprint`
            : "fingerprint required: compare the instance's key fingerprint with its sysop, then send it",
          compared ? 409 : 400,
          preview,
        );
    }
    const taken = await env.DB.prepare("SELECT 1 FROM fed_peers WHERE url = ? AND url != ?")
      .bind(found.url, row.url)
      .first();
    if (taken) throw new PeerAddRefused(`another peer already uses ${found.url}`, 409);
    const viaLan = lan.includes(found.url);
    await env.DB.prepare(
      `UPDATE fed_peers SET url = ?, public_key = ?, accept_keys = COALESCE(accept_keys, ?), enabled = 1,
         added_via = ?, trust = ?, auto_promoted_at = NULL,
         approved_at = CASE WHEN ? THEN COALESCE(approved_at, ?) ELSE approved_at END
       WHERE url = ?`,
    )
      .bind(
        found.url,
        found.publicKey,
        JSON.stringify([{ x: found.publicKey }]),
        viaLan ? "mdns" : "discovered",
        wantTrust ? "trusted" : "unvetted",
        wantTrust ? 1 : 0,
        nowS(),
        row.url,
      )
      .run();
    return json({ ok: true, peer: { ...preview, trust: wantTrust ? "trusted" : "unvetted" } });
  } catch (e) {
    if (e instanceof PeerAddRefused)
      return json({ error: e.message, ...(e.preview && { preview: e.preview }) }, { status: e.status });
    throw e;
  }
}
