// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedsynclink.ts — the operator-local ends of the connected-mode federation sync binding. The RF
 * circuit itself (dialing an AX.25/NET-ROM path, keying the radio) rides the same driver stack as
 * FBB forwarding and is validate-at-deploy; these are the two protocol ends around it:
 *
 *   - serve: a `FedSyncApp` whose page source is THIS operator's gateway CBOR sync surface — mount
 *     it as a session-server service (or behind the node) and a station that connects can pull our
 *     signed feed over the air.
 *   - pull:  a `FedSyncLinkClient` pump over an injected line transport — pulls a peer's pages over
 *     the circuit and delivers them to OUR gateway's /federation/frames, where the trust-gated
 *     pipeline verifies every frame. The ingest holds no keys and makes no trust decisions.
 */
import { FedSyncApp, FedSyncLinkClient, type LinkPayloadCodec } from "@aprsweb/packet";
import { decodeFedSyncPage, FED_DEFLATE_DICT_ID, type LinkCaps } from "@aprsweb/shared";
import { compressDict1, decompressDict1 } from "./fedcompress.js";

/** The compact-tier profile an operator-local VHF port advertises. */
export const VHF_COMPACT_CAPS: LinkCaps = {
  mode: "sync",
  mtu: 1024,
  rateClass: "vhf1200",
  batchMax: 25,
  compress: [FED_DEFLATE_DICT_ID, "deflate", "none"],
  recordSet: "compact",
};

export const dict1Codec: LinkPayloadCodec = { compress: compressDict1, decompress: decompressDict1 };

type FetchFn = typeof fetch;

/** Build the servable sync app: pages come from this operator's own gateway CBOR sync surface. */
export function makeFedSyncApp(opts: {
  gatewayBase: string;
  caps?: LinkCaps;
  fetchFn?: FetchFn;
  codec?: LinkPayloadCodec;
}): FedSyncApp {
  const f = opts.fetchFn ?? fetch;
  return new FedSyncApp(
    opts.caps ?? VHF_COMPACT_CAPS,
    async (type, since, limit) => {
      const res = await f(
        `${opts.gatewayBase}/federation/sync/${encodeURIComponent(type)}?since=${since}&limit=${limit}`,
      );
      if (res.status === 404) return null; // unknown feed / unsigned instance — the app reports E
      if (!res.ok) throw new Error(`gateway sync ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    opts.codec ?? dict1Codec,
  );
}

export interface FedSyncPullResult {
  pages: number;
  frames: number;
  applied: number;
  quarantined: number;
  rejected: number;
}

/**
 * Pull one feed type over an established circuit and deliver every page to our gateway. The line
 * transport is injected: `sendLine` writes to the circuit, and the driver feeds received lines into
 * the returned client via `onLine`. Runs until the peer reports a complete page or `maxPages`.
 */
export async function pullFedSync(opts: {
  client: FedSyncLinkClient;
  gatewayBase: string;
  secret: string;
  type: string;
  since?: number;
  limit?: number;
  maxPages?: number;
  fetchFn?: FetchFn;
}): Promise<FedSyncPullResult> {
  const f = opts.fetchFn ?? fetch;
  const out: FedSyncPullResult = { pages: 0, frames: 0, applied: 0, quarantined: 0, rejected: 0 };
  let since = opts.since ?? 0;
  const maxPages = opts.maxPages ?? 50;
  for (let i = 0; i < maxPages; i++) {
    const pageBytes = await opts.client.pull(opts.type, since, opts.limit ?? 25);
    const page = decodeFedSyncPage(pageBytes);
    out.pages++;
    out.frames += page.frames.length;
    if (page.frames.length) {
      const res = await f(`${opts.gatewayBase}/federation/frames`, {
        method: "POST",
        headers: { "content-type": "application/cbor", "x-ingest-secret": opts.secret },
        body: pageBytes as unknown as BodyInit,
      });
      if (!res.ok) throw new Error(`gateway frames ${res.status}`);
      const r = (await res.json()) as { applied?: number; quarantined?: number; rejected?: number };
      out.applied += r.applied ?? 0;
      out.quarantined += r.quarantined ?? 0;
      out.rejected += r.rejected ?? 0;
    }
    if (page.complete || page.nextCursor <= since) break;
    since = page.nextCursor;
  }
  return out;
}

export { FedSyncLinkClient } from "@aprsweb/packet";
