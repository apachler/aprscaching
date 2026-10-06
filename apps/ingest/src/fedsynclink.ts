// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedsynclink.ts — the operator-local ends of the connected-mode federation sync binding. The circuit
 * itself (dialing an AX.25/NET-ROM path, keying the radio) is fedlink.ts, over the same driver stack as FBB
 * forwarding; these are the two protocol ends around it:
 *
 *   - serve: a `FedSyncApp` whose page source is THIS operator's gateway CBOR sync surface — mounted on
 *     FED_LINK_CALL and as the node's `FED` command, so a station that connects can pull our signed feed.
 *   - pull:  a `FedSyncLinkClient` pump over an injected line transport — pulls a peer's pages over
 *     the circuit and delivers them to OUR gateway's /federation/frames, where the trust-gated
 *     pipeline verifies every frame. The ingest holds no keys and makes no trust decisions.
 */
import { gatewayFetch } from "./gatewayauth.js";
import { FedSyncApp, FedSyncLinkClient, type LinkPayloadCodec } from "@aprscaching/packet";
import { decodeFedSyncPage, FED_DEFLATE_DICT_ID, type LinkCaps } from "@aprscaching/shared";
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
  const f = opts.fetchFn ?? gatewayFetch;
  return new FedSyncApp(
    opts.caps ?? VHF_COMPACT_CAPS,
    async (type, since, limit, sinceId) => {
      const idParam = sinceId !== undefined ? `&sinceId=${sinceId}` : "";
      const res = await f(
        `${opts.gatewayBase}/federation/sync/${encodeURIComponent(type)}?since=${since}&limit=${limit}${idParam}`,
      );
      if (res.status === 404) return null; // unknown feed / unsigned instance — the app reports E
      if (!res.ok) throw new Error(`gateway sync ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    opts.codec ?? dict1Codec,
  );
}

/** Where a feed's pull resumes: after `since`, and for a composite feed strictly after `(since, sinceId)`. */
export interface FeedCursor {
  since: number;
  sinceId?: number;
}

export interface FedSyncPullResult {
  pages: number;
  frames: number;
  applied: number;
  quarantined: number;
  rejected: number;
  /** The position to resume from next time; it moves only past pages the gateway took. */
  cursor: FeedCursor;
  /** The peer reported the feed complete: nothing left past `cursor`. */
  complete: boolean;
}

/**
 * Pull one feed type over an established circuit and deliver every page to our gateway. The line
 * transport is injected: `sendLine` writes to the circuit, and the driver feeds received lines into
 * the returned client via `onLine`. Runs until the peer reports a complete page, the cursor stops moving, or
 * `maxPages`. A composite feed (a repeating timestamp cursor) carries the page's `nextId` into the next request;
 * after a complete page it resumes from the timestamp alone, as the HTTP pull does, so a row updated later at the
 * same second is not skipped.
 */
export async function pullFedSync(opts: {
  client: Pick<FedSyncLinkClient, "pull">;
  gatewayBase: string;
  secret: string;
  type: string;
  cursor?: FeedCursor;
  limit?: number;
  maxPages?: number;
  fetchFn?: FetchFn;
}): Promise<FedSyncPullResult> {
  const f = opts.fetchFn ?? gatewayFetch;
  let cursor: FeedCursor = { ...(opts.cursor ?? { since: 0 }) };
  const out: FedSyncPullResult = {
    pages: 0,
    frames: 0,
    applied: 0,
    quarantined: 0,
    rejected: 0,
    cursor,
    complete: false,
  };
  const maxPages = opts.maxPages ?? 50;
  for (let i = 0; i < maxPages; i++) {
    const pageBytes = await opts.client.pull(opts.type, cursor.since, opts.limit ?? 25, cursor.sinceId);
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
    const next: FeedCursor = {
      since: page.nextCursor,
      ...(!page.complete && page.nextId !== undefined && { sinceId: page.nextId }),
    };
    const moved = next.since !== cursor.since || next.sinceId !== cursor.sinceId;
    cursor = page.nextCursor >= cursor.since ? next : cursor;
    out.cursor = cursor;
    if (page.complete) {
      out.complete = true;
      break;
    }
    if (!moved) break;
  }
  return out;
}

export { FedSyncLinkClient } from "@aprscaching/packet";
