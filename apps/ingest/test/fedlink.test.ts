// SPDX-License-Identifier: AGPL-3.0-or-later
// The packet pull scheduler over an in-memory circuit: the far end is the real serving app (sync pages from a
// stand-in gateway), the near end delivers to a stand-in of our gateway. One session per round, the page
// budget, back-off from a failing peer, the transmit switch, and the dial plans for ax25 and netrom endpoints.
import { describe, it, expect } from "vitest";
import { encodeFedSyncPage } from "@aprscaching/shared";
import { withFedSyncCommand, type ForwardLink, type LineApp } from "@aprscaching/packet";
import { makeFedSyncApp } from "../src/fedsynclink.js";
import {
  CircuitLines,
  dialPlan,
  FedLinkPuller,
  FED_LINK_FEEDS,
  type DialPlan,
  type PacketPeer,
  type PacketReport,
} from "../src/fedlink.js";

const frame = (n: number) => Uint8Array.from({ length: 20 }, (_, i) => (n * 7 + i) & 0xff);

/** The serving gateway: the cache feed has two pages, every other feed one empty complete page. */
function servingFetch(calls: string[]): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    const type = u.pathname.split("/").pop();
    const since = Number(u.searchParams.get("since"));
    const body =
      type === "cache"
        ? since < 10
          ? encodeFedSyncPage("oe.b", 10, false, [frame(1), frame(2)], 3)
          : encodeFedSyncPage("oe.b", 20, true, [frame(3)])
        : encodeFedSyncPage("oe.b", since, true, []);
    return new Response(body as unknown as BodyInit, { headers: { "content-type": "application/cbor" } });
  }) as typeof fetch;
}

/** Our gateway: count delivered pages, apply every frame. */
function receivingFetch(delivered: number[]): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    delivered.push((init?.body as Uint8Array).length);
    return new Response(JSON.stringify({ applied: 1, quarantined: 0, rejected: 0 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** A circuit to a line app: what the near end sends is handled by the app, its replies come back as bytes. */
function circuit(app: LineApp, opts: { fail?: boolean; dialled?: DialPlan[]; plan: DialPlan }): ForwardLink {
  opts.dialled?.push(opts.plan);
  const data: ((b: Uint8Array) => void)[] = [];
  const closed: (() => void)[] = [];
  const enc = new TextEncoder();
  const lines = new CircuitLines();
  const reply = (ls: string[]) => {
    for (const l of ls) for (const cb of data) cb(enc.encode(l + "\r"));
  };
  let chain = Promise.resolve();
  return {
    connect: () =>
      opts.fail
        ? Promise.reject(new Error("connect timeout"))
        : Promise.resolve().then(() => {
            setTimeout(() => reply(app.greeting()), 0);
          }),
    send: (bytes) => {
      for (const l of lines.push(bytes))
        chain = chain.then(async () => {
          reply((await app.handle(l)).lines);
        });
    },
    onData: (cb) => void data.push(cb),
    onClose: (cb) => void closed.push(cb),
    disconnect: () => {
      for (const c of closed.splice(0)) c();
    },
  };
}

function setup(o: { peers: PacketPeer[]; fail?: Set<string>; canTx?: () => boolean; maxPages?: number }) {
  const served: string[] = [];
  const delivered: number[] = [];
  const reports: PacketReport[] = [];
  const dialled: DialPlan[] = [];
  const app = () => makeFedSyncApp({ gatewayBase: "http://b", fetchFn: servingFetch(served) });
  const puller = new FedLinkPuller({
    peers: async () => o.peers,
    report: async (r) => void reports.push(r),
    dial: (plan) =>
      circuit(
        plan.command ? withFedSyncCommand({ greeting: () => ["node>"], handle: () => ({ lines: [] }) }, app) : app(),
        {
          plan,
          dialled,
          fail: o.fail?.has(plan.target),
        },
      ),
    gatewayBase: "http://a",
    secret: "s",
    fetchFn: receivingFetch(delivered),
    canTransmit: o.canTx ?? (() => true),
    entryNode: "OE1NOD-7",
    maxPages: o.maxPages,
    log: () => {},
  });
  return { puller, served, delivered, reports, dialled };
}

const peerB: PacketPeer = { instance: "oe.b", endpoints: [{ transport: "ax25", address: "OE1BBB-9" }], cursors: {} };

describe("packet pull scheduler", () => {
  it("pulls every feed in one session, delivers the pages and reports the new cursors", async () => {
    const t = setup({ peers: [peerB] });
    const r = await t.puller.round();
    expect(r).toMatchObject({ instance: "oe.b", ok: true, complete: true, pages: 7, frames: 3, applied: 2 });
    expect(t.delivered).toHaveLength(2); // only pages with frames reach the gateway
    expect(r!.cursors.cache).toEqual({ since: 20 }); // after a complete page the id tie-breaker is dropped
    expect(Object.keys(r!.cursors)).toEqual([...FED_LINK_FEEDS]);
    expect(t.served).toContain("/federation/sync/cache?since=10&limit=25&sinceId=3"); // the composite cursor
    expect(t.reports).toEqual([r]);
  });

  it("resumes from the gateway's cursors and stops at the page budget", async () => {
    const t = setup({ peers: [{ ...peerB, cursors: { tombstone: { since: 4 } } }], maxPages: 2 });
    const r = await t.puller.round();
    expect(r).toMatchObject({ ok: true, complete: false, pages: 2 });
    expect(t.served[0]).toBe("/federation/sync/tombstone?since=4&limit=25");
    expect(Object.keys(r!.cursors)).toEqual(["tombstone", "cache"]);
    expect(r!.cursors.cache).toEqual({ since: 10, sinceId: 3 });
  });

  it("backs off from a failing peer and moves on to the next", async () => {
    const peerC: PacketPeer = {
      instance: "oe.c",
      endpoints: [{ transport: "ax25", address: "OE1CCC-9" }],
      cursors: {},
    };
    const t = setup({ peers: [peerB, peerC], fail: new Set(["OE1BBB-9"]) });
    const first = await t.puller.round();
    expect(first).toMatchObject({ instance: "oe.b", ok: false, error: "connect timeout" });
    expect(await t.puller.round()).toMatchObject({ instance: "oe.c", ok: true }); // oe.b waits a round
    expect((await t.puller.round())?.instance).toBe("oe.b"); // then is tried again
    expect((await t.puller.round())?.instance).toBe("oe.c"); // a second failure doubles the wait
    expect((await t.puller.round())?.instance).toBe("oe.c");
    expect((await t.puller.round())?.instance).toBe("oe.b");
  });

  it("does not dial while transmit is switched off, nor twice at once", async () => {
    let tx = false;
    const t = setup({ peers: [peerB], canTx: () => tx });
    expect(await t.puller.round()).toBeNull();
    expect(t.dialled).toHaveLength(0);
    tx = true;
    const [a, b] = await Promise.all([t.puller.round(), t.puller.round()]);
    expect([a?.ok, b]).toEqual([true, null]);
  });

  it("enters a netrom endpoint through the node and starts the service with FED", async () => {
    const t = setup({ peers: [{ ...peerB, endpoints: [{ transport: "netrom", address: "acsb" }] }] });
    const r = await t.puller.round();
    expect(r).toMatchObject({ ok: true, transport: "netrom", address: "acsb" });
    expect(t.dialled[0]).toEqual({ target: "ACSB", connectScript: "C OE1NOD-7\nC ACSB", command: "FED" });
  });
});

describe("dial plans and circuit lines", () => {
  it("dials an ax25 endpoint directly and needs an entry node for a netrom one", () => {
    expect(dialPlan({ transport: "ax25", address: "oe1bbb-9" }, undefined)).toEqual({
      target: "OE1BBB-9",
      connectScript: "",
    });
    expect(dialPlan({ transport: "netrom", address: "ACSB" }, undefined)).toHaveProperty("skip");
  });

  it("splits lines on CR or LF across chunks", () => {
    const l = new CircuitLines();
    const enc = new TextEncoder();
    expect(l.push(enc.encode("ACSL1 H ab"))).toEqual([]);
    expect(l.push(enc.encode("c\rnext\r\nlast"))).toEqual(["ACSL1 H abc", "next"]);
    expect(l.push(enc.encode("\n"))).toEqual(["last"]);
  });
});
