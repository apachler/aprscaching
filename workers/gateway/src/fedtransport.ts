// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedtransport.ts — the two-tier federation transport seam. Records are signed CBOR/JSON whose
 * authenticity lives in their bytes, so transports are interchangeable carriers in two shapes:
 *
 *   - {@link FedSyncTransport}: request/response pull-sync (HTTP over the internet or over
 *     44net/HAMNET amateur IP space). The adapter here serves both — 44net sync IS HTTP, just
 *     addressed by an amateur-space name.
 *   - {@link FedForwardTransport}: fire-and-forget store-and-forward delivery (BBS forwarding, the
 *     rendezvous relay, packet circuits). Nothing to negotiate live — the carrier's limits are
 *     operator config; frames are applied idempotently by global id on arrival.
 *
 * Endpoint selection: a peer row carries an ordered typed endpoint set (`endpoints` JSON); the
 * lowest-priority sync-capable endpoint wins, with the legacy `url` column as the https fallback.
 */
import { parseEndpoints, type FedEndpoint, type FedTransportKind } from "@aprscaching/shared";

export const PEER_FETCH_TIMEOUT_MS = 5000; // a blackholed peer must not hang the whole sync cron

export interface FedSyncTransport {
  readonly kind: FedTransportKind;
  /** The peer's base URL for this endpoint (no trailing slash). */
  readonly baseUrl: string;
  /** GET an absolute path (leading slash) on the peer; timeout-bounded, returns the raw Response. */
  get(path: string): Promise<Response>;
  /** GET + parse JSON, throwing on any non-2xx status. */
  fetchJson<T>(path: string): Promise<T>;
}

export interface FedForwardTransport {
  readonly kind: FedTransportKind;
  /** Hand signed wire frames to the carrier; delivery is asynchronous and unacknowledged. */
  enqueue(frames: Uint8Array[]): Promise<void>;
}

/** The peer row fields endpoint resolution reads (a subset of the fed_peers row). */
export interface PeerAddressing {
  url?: string | null;
  endpoints?: string | null;
}

/** A peer's typed endpoint set, priority-ordered, with the legacy https `url` as the fallback. */
export function peerEndpoints(p: PeerAddressing): FedEndpoint[] {
  if (p.endpoints) {
    try {
      const list = parseEndpoints(JSON.parse(p.endpoints));
      if (list.length) return list;
    } catch {
      /* malformed stored endpoints → fall back to the url column */
    }
  }
  return p.url ? parseEndpoints([{ transport: "https", address: p.url, priority: 50 }]) : [];
}

/**
 * The base URL a sync-capable endpoint resolves to, or null for packet-radio endpoints (ax25 /
 * netrom / bbs carry forward-mode frames via the ingest box, never request/response sync here).
 * 44net endpoints resolve to plain http on the amateur-space name — 44net/HAMNET addresses have no
 * public-CA TLS, and record authenticity comes from signatures, not the channel.
 */
export function endpointBaseUrl(e: FedEndpoint): string | null {
  if (e.transport === "https") return e.address.replace(/\/+$/, "");
  if (e.transport === "44net") return `http://${e.address}`;
  return null;
}

function httpSyncTransport(kind: FedTransportKind, baseUrl: string): FedSyncTransport {
  return {
    kind,
    baseUrl,
    get(path: string): Promise<Response> {
      return fetch(`${baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS),
      });
    },
    async fetchJson<T>(path: string): Promise<T> {
      const r = await this.get(path);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} <- ${baseUrl}${path}`);
      return r.json() as Promise<T>;
    },
  };
}

/** Pick the peer's best sync transport: the first (lowest-priority) endpoint that resolves to a URL. */
export function syncTransportFor(p: PeerAddressing): FedSyncTransport | null {
  for (const e of peerEndpoints(p)) {
    const base = endpointBaseUrl(e);
    if (base) return httpSyncTransport(e.transport, base);
  }
  return null;
}
