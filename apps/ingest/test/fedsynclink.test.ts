// SPDX-License-Identifier: AGPL-3.0-or-later
// Both operator-local ends of the connected-mode sync binding, wired over an in-memory line pair
// with the REAL deflateDict1 codec: the serving side sources pages from its gateway's CBOR sync
// surface, the pulling side delivers every page to its own gateway's /federation/frames.
import { describe, it, expect } from "vitest";
import { makeFedSyncApp, pullFedSync, FedSyncLinkClient, VHF_COMPACT_CAPS, dict1Codec } from "../src/fedsynclink.js";
import { encodeFedSyncPage } from "@aprsweb/shared";

const frame = (n: number) => Uint8Array.from({ length: 30 }, (_, i) => (n * 13 + i) & 0xff);

/** Two pages of two frames, then a complete page — a tiny feed with a moving cursor. */
function servingGateway(): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    const since = Number(u.searchParams.get("since"));
    const body =
      since < 2
        ? encodeFedSyncPage("oe.pub", 2, false, [frame(1), frame(2)])
        : encodeFedSyncPage("oe.pub", 4, true, [frame(3)]);
    return new Response(body as unknown as BodyInit, { headers: { "content-type": "application/cbor" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** The pulling side's gateway: capture delivered pages, answer with apply counts. */
function receivingGateway(): { fetchFn: typeof fetch; delivered: Uint8Array[] } {
  const delivered: Uint8Array[] = [];
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    delivered.push(new Uint8Array(init?.body as ArrayBuffer extends never ? never : Uint8Array));
    return new Response(JSON.stringify({ federation: true, applied: 2, quarantined: 0, rejected: 0 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, delivered };
}

describe("connected-mode sync: both operator-local ends over a line pair", () => {
  it("pulls a peer's feed over the circuit and delivers every page to the local gateway", async () => {
    const serving = servingGateway();
    const app = makeFedSyncApp({ gatewayBase: "http://127.0.0.1:8787", fetchFn: serving.fetchFn });

    const client: FedSyncLinkClient = new FedSyncLinkClient(
      VHF_COMPACT_CAPS,
      {
        sendLine: (line) => {
          void Promise.resolve(app.handle(line)).then((r) => {
            for (const l of r.lines) client.onLine(l);
          });
        },
      },
      dict1Codec,
    );
    const hello = client.hello();
    for (const l of app.greeting()) client.onLine(l);
    const caps = await hello;
    expect(caps.compress[0]).toBe("deflateDict1"); // both ends carry the dictionary

    const receiving = receivingGateway();
    const res = await pullFedSync({
      client,
      gatewayBase: "http://127.0.0.1:8797",
      secret: "s",
      type: "cache",
      fetchFn: receiving.fetchFn,
    });
    expect(res).toMatchObject({ pages: 2, frames: 3, applied: 4 });
    expect(receiving.delivered).toHaveLength(2);
    expect(serving.calls[0]).toContain("/federation/sync/cache?since=0");
    expect(serving.calls[1]).toContain("since=2");
  });
});
