// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedtransport.ts — the two-tier federation transport seam. Records are signed CBOR/JSON whose
 * authenticity lives in their bytes, so transports are interchangeable carriers in two shapes:
 *
 *   - {@link FedSyncTransport}: request/response pull-sync (HTTP over the internet, over 44Net or over
 *     HAMNET). The adapter here serves all three — 44Net and HAMNET sync IS HTTP, just addressed in
 *     amateur IP space.
 *   - fire-and-forget store-and-forward delivery (BBS forwarding, the rendezvous relay, packet
 *     circuits). Nothing to negotiate live — the carrier's limits are operator config; frames are
 *     applied idempotently by global id on arrival (fedapply.ts).
 *
 * Endpoint selection: a peer row carries an ordered typed endpoint set (`endpoints` JSON). The sync
 * transport tries the sync-capable addresses in priority order — a `44net` name with a certificate over
 * https and then plain http, a `hamnet` host with a short timeout, since most peers have no route to
 * HAMNET — and keeps the first that answers. The row's `url`, the address the peer was added under, is
 * always among them: last, unless the endpoint set lists it. A peer without an endpoint set (a FED_PEERS URL, a
 * discovered or submitted peer before its first sync) is reached at its `url` alone. A plain `http://` url is a
 * HAMNET peer the sysop declared, dialled like a `hamnet` endpoint, unless it names a LAN or loopback address:
 * no address range tells a HAMNET host from one on the internet, so the scheme the sysop wrote decides.
 *
 * The endpoint set comes from DNS (a peer added by callsign, fed44net.ts), from the `addresses` of the peer's
 * own descriptor (fedpull.ts) or from its presence beacon (fedapply.ts); {@link mergeEndpoints} folds what a
 * peer says about itself into the stored set without dropping what DNS attested or the row's own address.
 */
import {
  endpointBaseUrls,
  parseEndpoints,
  validEndpointAddress,
  type FedEndpoint,
  type FedTransportKind,
} from "@aprscaching/shared";
import { isLocalHost } from "./fetchguard.js";

const PEER_FETCH_TIMEOUT_MS = 5000; // a blackholed peer must not hang the whole sync cron
/** A HAMNET host either routes from here or not at all: a short wait, then the next address. */
const HAMNET_FETCH_TIMEOUT_MS = 2000;

export interface FedSyncTransport {
  /** The kind of the address in use: the first that answered, or the first to try before any request. */
  readonly kind: FedTransportKind;
  /** The peer's base URL in use (no trailing slash), as `kind`. */
  readonly baseUrl: string;
  /** GET an absolute path (leading slash) on the peer; timeout-bounded, returns the raw Response. */
  get(path: string): Promise<Response>;
  /** GET + parse JSON, throwing on any non-2xx status. */
  fetchJson<T>(path: string): Promise<T>;
}

/** The peer row fields endpoint resolution reads (a subset of the fed_peers row). */
interface PeerAddressing {
  url?: string | null;
  endpoints?: string | null;
}

/** A stored endpoint set, priority-ordered; empty when there is none or it does not parse. */
export function storedEndpoints(raw: string | null | undefined): FedEndpoint[] {
  if (!raw) return [];
  try {
    return parseEndpoints(JSON.parse(raw));
  } catch {
    return []; // a malformed stored endpoint set leaves the url
  }
}

/**
 * The transport a peer row's own `url` is dialled as: a plain-http base with no path is `hamnet`, with the short
 * timeout, unless its host is a LAN or loopback address; anything else keeps the full timeout.
 */
export function urlTransport(url: string): FedTransportKind {
  if (!/^http:\/\//i.test(url) || !validEndpointAddress("hamnet", url)) return "https";
  try {
    return isLocalHost(new URL(url).hostname) ? "https" : "hamnet";
  } catch {
    return "https";
  }
}

/** A peer's typed endpoint set, priority-ordered, with its `url` last unless the set lists it. */
export function peerEndpoints(p: PeerAddressing): FedEndpoint[] {
  const list = storedEndpoints(p.endpoints);
  // The url column is written by the operator (FED_PEERS, the admin surface) or by a path that already
  // validated it, and may be plain http on a LAN or HAMNET peer, so it is taken as given.
  const url = p.url && /^https?:\/\//.test(p.url) ? p.url : null;
  if (url && !list.some((e) => endpointBaseUrls(e).includes(url)))
    list.push({ transport: urlTransport(url), address: url, priority: 100 });
  return list;
}

/** Most endpoints a peer row keeps: a peer cannot grow its row without bound through what it announces. */
const MAX_PEER_ENDPOINTS = 16;

const endpointKey = (e: FedEndpoint) => `${e.transport} ${e.address.toLowerCase()}`;

/**
 * Fold the endpoints a peer publishes about itself (its descriptor's `addresses`, a presence beacon) into the
 * stored set. `replace` takes the incoming set as the peer's whole list, so an address it no longer lists goes;
 * otherwise (a beacon, trimmed to fit one datagram) nothing stored is dropped. Either way an endpoint DNS
 * attested (`verifiedVia: "ardc-lot"`) and the row's own `url` stay as stored, and an incoming endpoint never
 * carries an attestation: a peer cannot vouch for itself. Pure.
 */
export function mergeEndpoints(
  stored: FedEndpoint[],
  incoming: FedEndpoint[],
  opts: { url?: string | null; replace: boolean },
): FedEndpoint[] {
  const kept = (e: FedEndpoint) =>
    e.verifiedVia === "ardc-lot" || (!!opts.url && endpointBaseUrls(e).includes(opts.url));
  const out = new Map<string, { e: FedEndpoint; kept: boolean }>();
  for (const e of stored) if (!opts.replace || kept(e)) out.set(endpointKey(e), { e, kept: kept(e) });
  for (const raw of incoming) {
    const e: FedEndpoint = { transport: raw.transport, address: raw.address, priority: raw.priority };
    const k = endpointKey(e);
    if (!out.get(k)?.kept) out.set(k, { e, kept: false });
  }
  const all = [...out.values()].sort((a, b) => a.e.priority - b.e.priority);
  const room = Math.max(0, MAX_PEER_ENDPOINTS - all.filter((x) => x.kept).length);
  const learned = new Set(all.filter((x) => !x.kept).slice(0, room));
  return all.filter((x) => x.kept || learned.has(x)).map((x) => x.e);
}

interface SyncAddress {
  kind: FedTransportKind;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * Every base URL a sync may use, in the order to try them; packet endpoints carry none. Corroboration asks a
 * peer at the same addresses.
 */
export function syncAddresses(p: PeerAddressing): SyncAddress[] {
  const out: SyncAddress[] = [];
  for (const e of peerEndpoints(p)) {
    for (const baseUrl of endpointBaseUrls(e))
      if (!out.some((a) => a.baseUrl === baseUrl))
        out.push({
          kind: e.transport,
          baseUrl,
          timeoutMs: e.transport === "hamnet" ? HAMNET_FETCH_TIMEOUT_MS : PEER_FETCH_TIMEOUT_MS,
        });
  }
  return out;
}

/**
 * The peer's sync transport, or null when it has no sync-capable address. Until one answers, a request tries
 * each address in turn, moving on when the connection fails or times out (a refused certificate, no route);
 * an address that answers at all, with any status, is kept for the rest of the sync.
 */
export function syncTransportFor(
  p: PeerAddressing,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
): FedSyncTransport | null {
  const addresses = syncAddresses(p);
  if (!addresses.length) return null;
  let chosen: SyncAddress | null = null;
  const attempt = (a: SyncAddress, path: string) =>
    fetchFn(`${a.baseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(a.timeoutMs),
    });
  return {
    get kind() {
      return (chosen ?? addresses[0]!).kind;
    },
    get baseUrl() {
      return (chosen ?? addresses[0]!).baseUrl;
    },
    async get(path: string): Promise<Response> {
      if (chosen) return attempt(chosen, path);
      let last: unknown = null;
      for (const a of addresses) {
        try {
          const res = await attempt(a, path);
          chosen = a;
          return res;
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new Error(`no address of the peer answered: ${String(last)}`);
    },
    async fetchJson<T>(path: string): Promise<T> {
      const r = await this.get(path);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} <- ${this.baseUrl}${path}`);
      return r.json() as Promise<T>;
    },
  };
}
