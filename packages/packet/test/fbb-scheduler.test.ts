// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { BbsForwarder, type ForwardApi, type ForwardLink, type GwPartner } from "../src/fbb-scheduler.js";
import { FbbForwarder } from "../src/fbb-forward.js";
import { type FbbMessage, type FbbStore } from "../src/fbb-session.js";

const partner = (o: Partial<GwPartner> = {}): GwPartner => ({
  id: 1, call: "DB0XYZ-1", ha: "DB0XYZ.DL.EU", connectScript: "", proto: "rf-fbb",
  intervalMin: 30, timebands: "", requestReverse: true, msgtypes: "PBT", maxBlock: 5, enabled: true, ...o,
});
const msg = (o: Partial<FbbMessage> & Pick<FbbMessage, "from" | "to" | "bid" | "title" | "body">): FbbMessage =>
  ({ type: "P", at: "WW", ...o });

/** An in-memory FbbStore for the far-end partner BBS. */
function makeStore(out: FbbMessage[]): FbbStore & { inbox: FbbMessage[]; queue: FbbMessage[] } {
  const queue = [...out]; const inbox: FbbMessage[] = []; const held = new Set(out.map((m) => m.bid));
  return {
    queue, inbox, outbound: () => queue, hasBid: (b) => held.has(b),
    accept: (m) => { inbox.push(m); held.add(m.bid); },
    sent: (b) => { const i = queue.findIndex((m) => m.bid === b); if (i >= 0) queue.splice(i, 1); },
  };
}

/** A fake ForwardApi: an outbound pool + captured inbound/markSent, so we assert the reconcile. */
function fakeApi(partners: GwPartner[], pool: Record<string, FbbMessage[]>) {
  const inbound: { m: FbbMessage; origin: string }[] = [];
  const marked: Record<string, string[]> = {};
  const api: ForwardApi = {
    partners: async () => partners,
    pool: async (call) => (pool[call] ?? []).slice(),
    inbound: async (m, origin) => { inbound.push({ m, origin }); },
    markSent: async (call, bids) => { marked[call] = [...(marked[call] ?? []), ...bids]; },
  };
  return { api, inbound, marked };
}

/**
 * A ForwardLink that bridges our forwarder to a far-end partner running its OWN FbbForwarder (responder),
 * over a deferred byte queue — a full FBB exchange with no radio. The partner's store is `farStore`.
 */
function loopbackLinkFactory(farStore: FbbStore): ForwardLink {
  const far = new FbbForwarder(farStore, { initiator: false });
  const q: Array<{ to: "near" | "far"; bytes: Uint8Array }> = [];
  let onData: (b: Uint8Array) => void = () => {};
  let onClose: () => void = () => {};
  const pump = (guard = 5000) => {
    while (q.length && guard-- > 0) {
      const { to, bytes } = q.shift()!;
      if (to === "far") { const out = far.onData(bytes); if (out) q.push({ to: "near", bytes: out }); if (far.done) { queueMicrotask(onClose); } }
      else onData(bytes);
    }
  };
  return {
    connect: async () => {},
    send: (bytes) => { q.push({ to: "far", bytes }); pump(); },
    onData: (cb) => { onData = cb; },
    onClose: (cb) => { onClose = cb; },
    disconnect: () => { onClose(); },
  };
}

describe("FBB forwarding scheduler end-to-end (docs/design/29 F4)", () => {
  it("forwards our pool to a partner and stores what the partner sends back", async () => {
    const ours = msg({ from: "OE8APR", to: "DL1ABC", at: "DB0XYZ.DL.EU", bid: "1_oe", title: "hi", body: "hello DL\nline two" });
    const theirs = msg({ type: "B", from: "DB0XYZ", to: "ALL", at: "WW", bid: "9_db0", title: "Net", body: "net on 144.800" });
    const { api, inbound, marked } = fakeApi([partner()], { "DB0XYZ-1": [ours] });
    const farStore = makeStore([theirs]);

    const fwd = new BbsForwarder({ api, linkFactory: () => loopbackLinkFactory(farStore), now: () => 1000 });
    const result = await fwd.runSession(partner());

    // our message reached the partner; the partner's bulletin came back to the gateway
    expect(farStore.inbox.map((m) => m.bid)).toEqual(["1_oe"]);
    expect(farStore.inbox[0]).toMatchObject({ from: "OE8APR", to: "DL1ABC", body: "hello DL\nline two" });
    expect(inbound.map((i) => i.m.bid)).toEqual(["9_db0"]);
    expect(inbound[0]!.origin).toBe("rf-fbb:DB0XYZ-1");
    expect(marked["DB0XYZ-1"]).toEqual(["1_oe"]);        // our forwarded message marked sent (won't re-offer)
    expect(result).toEqual({ forwarded: 1, received: 1 });
  });

  it("tick() only forwards due partners and skips ip-fed / disabled", async () => {
    const calls: string[] = [];
    const partners = [
      partner({ call: "DB0RF-1", proto: "rf-fbb" }),
      partner({ call: "IPFED", proto: "ip-fed" }),          // signed federation, not an RF session
      partner({ call: "DB0OFF-1", proto: "rf-fbb", enabled: false }),
    ];
    const { api } = fakeApi(partners, {});
    const fwd = new BbsForwarder({
      api,
      linkFactory: (p) => { calls.push(p.call); return loopbackLinkFactory(makeStore([])); },
      now: () => 1000,
    });
    await fwd.tick();
    expect(calls).toEqual(["DB0RF-1"]);                    // only the enabled rf-fbb partner ran

    // a second immediate tick does nothing (interval not elapsed)
    await fwd.tick();
    expect(calls).toEqual(["DB0RF-1"]);
  });
});
