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
 * HAMNET — and keeps the first that answers. A peer without an endpoint set (a FED_PEERS URL, a
 * discovered or submitted peer) is reached at its `url`, the address it was added under.
 */
import { endpointBaseUrls, parseEndpoints, type FedEndpoint, type FedTransportKind } from "@aprscaching/shared";

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

/** A peer's typed endpoint set, priority-ordered; without one, its `url`. */
function peerEndpoints(p: PeerAddressing): FedEndpoint[] {
  if (p.endpoints) {
    try {
      const list = parseEndpoints(JSON.parse(p.endpoints));
      if (list.length) return list;
    } catch {
      /* a malformed stored endpoint set leaves the url */
    }
  }
  // The url column is written by the operator (FED_PEERS, the admin surface) or by a path that already
  // validated it, and may be plain http on a LAN or HAMNET peer, so it is taken as given.
  return p.url && /^https?:\/\//.test(p.url) ? [{ transport: "https", address: p.url, priority: 50 }] : [];
}

interface SyncAddress {
  kind: FedTransportKind;
  baseUrl: string;
  timeoutMs: number;
}

/** Every base URL a sync may use, in the order to try them; packet endpoints carry none. */
function syncAddresses(p: PeerAddressing): SyncAddress[] {
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
