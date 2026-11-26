// SPDX-License-Identifier: MIT
// A whole FBB forwarding session between two boxes over AX.25 connected mode: A's forwarding scheduler
// dials B's BBS call, B's session server answers with the SID-gated BBS, and the gate consults B's partner
// list the way the ingest does (an enabled partner with the caller's exact call and SSID). A listed partner's
// message lands at B and leaves A's pool; a caller B never listed is told so and nothing moves. Both sysops
// list each other, as on any FBB forwarding link.
import { describe, it, expect } from "vitest";
import { ConnectedLink, parseAddr, sameAddr, type Ax25Address, type Ax25Frame } from "@aprscaching/ax25";
import {
  BbsForwarder,
  FbbGatedBbs,
  SessionServer,
  SessionStore,
  type FbbMessage,
  type ForwardApi,
  type ForwardLink,
  type GwPartner,
  type LineApp,
} from "../src/index.js";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const partner = (call: string, enabled = true): GwPartner => ({
  id: 1,
  call,
  ha: "",
  proto: "rf-fbb",
  connectScript: "",
  intervalMin: 0,
  timebands: "",
  requestReverse: false,
  msgtypes: "PBT",
  maxBlock: 5,
  enabled,
});

const message: FbbMessage = {
  type: "P",
  from: "OE1AAA",
  at: "OE1BBB.OE.EU",
  to: "OE1TST",
  bid: "1_OE1AAA",
  title: "interop loop",
  body: "carried over AX.25 by the FBB forwarder",
};

const menu: LineApp = {
  greeting: () => ["Welcome to the BBS.", ">"],
  handle: () => ({ lines: ["?"] }),
};

/**
 * Two boxes on one channel: frames cross on a later turn of the event loop, as on a real port, so the
 * scheduler's awaits and the gate's async partner check interleave with the link the way they do live.
 */
function channel(bPartners: GwPartner[], aCall: string) {
  const landed: FbbMessage[] = [];
  const toB: Ax25Frame[] = [];
  const toA: Ax25Frame[] = [];
  let aLink: ConnectedLink | null = null;
  let heard = "";
  const flush = () =>
    setTimeout(() => {
      for (const f of toB.splice(0)) server.onFrame(f);
      for (const f of toA.splice(0)) aLink?.onReceive(f);
    });
  const server = new SessionServer({
    send: (f) => {
      toA.push(f);
      flush();
    },
    services: [
      {
        addr: parseAddr("OE1BBB-1"),
        name: "BBS",
        app: (remote: Ax25Address) =>
          new FbbGatedBbs(menu, {
            isPartner: async () => bPartners.some((p) => p.enabled && sameAddr(parseAddr(p.call), remote)),
            makeStore: () => new SessionStore([]),
            onSessionEnd: (s) => {
              landed.push(...(s as SessionStore).inbox);
            },
          }),
      },
    ],
  });

  /** A's dial-out, the scheduler's `ForwardLink` over a `ConnectedLink` on the shared channel. */
  const linkFactory = (): ForwardLink => {
    const dataCbs: ((b: Uint8Array) => void)[] = [];
    const closeCbs: (() => void)[] = [];
    const early: Uint8Array[] = [];
    let up: (() => void) | null = null;
    const link = new ConnectedLink(parseAddr(aCall), parseAddr("OE1BBB-1"), {
      send: (f) => {
        toB.push(f);
        flush();
      },
      deliver: (b) => {
        heard += dec(b);
        if (dataCbs.length) for (const c of dataCbs) c(b);
        else early.push(b);
      },
      state: (s) => {
        if (s === "connected") up?.();
        if (s === "disconnected") for (const c of closeCbs.splice(0)) c();
      },
    });
    aLink = link;
    return {
      connect: () =>
        new Promise<void>((resolve) => {
          up = resolve;
          link.connect();
        }),
      send: (b) => link.send(b),
      onData: (cb) => {
        dataCbs.push(cb);
        for (const b of early.splice(0)) cb(b);
      },
      onClose: (cb) => closeCbs.push(cb),
      disconnect: () => link.disconnect(),
    };
  };

  /** A hangs up as soon as it sends FQ: let the frames still on the channel reach B before asserting. */
  const settle = async () => {
    for (let i = 0; i < 50 && (toA.length || toB.length || aLink?.state !== "disconnected"); i++)
      await new Promise((r) => setTimeout(r, 0));
  };

  return { landed, linkFactory, settle, heard: () => heard };
}

/** A's gateway: one message pooled for OE1BBB-1; `markSent` drains the pool. */
function poolA() {
  const pool = [message];
  const api: ForwardApi = {
    partners: async () => [partner("OE1BBB-1")],
    pool: async () => [...pool],
    inbound: async () => {},
    markSent: async (_p, bids) => {
      for (const bid of bids) pool.splice(pool.findIndex((m) => m.bid === bid) >>> 0, 1);
    },
  };
  return { api, pool };
}

describe("FBB forwarding session over AX.25 into the SID-gated BBS", () => {
  it("carries a listed partner's message to B and drains A's pool", async () => {
    const ch = channel([partner("OE1AAA-1")], "OE1AAA-1");
    const a = poolA();
    const fwd = new BbsForwarder({ api: a.api, linkFactory: ch.linkFactory, sessionTimeoutMs: 5000 });

    const r = await fwd.runSession(partner("OE1BBB-1"));
    await ch.settle();

    expect(ch.landed.map((m) => [m.bid, m.to, m.title])).toEqual([["1_OE1AAA", "OE1TST", "interop loop"]]);
    expect(r.forwarded).toBe(1);
    expect(a.pool).toEqual([]);
    expect(ch.heard()).not.toContain("Not a forwarding partner");
  });

  it("refuses a caller B never listed, and nothing leaves A's pool", async () => {
    // B lists A's base call on another SSID, and a disabled entry with the right one: neither is A's BBS
    const ch = channel([partner("OE1AAA-2"), partner("OE1AAA-1", false)], "OE1AAA-1");
    const a = poolA();
    const fwd = new BbsForwarder({ api: a.api, linkFactory: ch.linkFactory, sessionTimeoutMs: 5000 });

    const r = await fwd.runSession(partner("OE1BBB-1"));
    await ch.settle();

    expect(ch.heard()).toContain("Not a forwarding partner");
    expect(ch.landed).toEqual([]);
    expect(r.forwarded).toBe(0);
    expect(a.pool.map((m) => m.bid)).toEqual(["1_OE1AAA"]);
  });
});
