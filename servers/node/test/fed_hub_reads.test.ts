// SPDX-License-Identifier: AGPL-3.0-or-later
// What a spoke or an asker reads back from a hub is read under a cap: the push marks and acknowledgements, a
// relay lease, a relay ticket and a relayed result. A hub that streams an endless body costs at most the cap,
// never the memory of a Pi or a phone.
import { describe, it, expect, afterEach, vi } from "vitest";
import { pushToHub } from "@aprscaching/gateway/fedpush";
import { relayPoll } from "@aprscaching/gateway/relay";
import { askPeers, collectRelayed } from "@aprscaching/gateway/corroborate";
import { addCache, instanceEnv, newFedKey, stubFetch } from "./helpers/fedpeer.js";

afterEach(() => vi.unstubAllGlobals());

const HUB = "https://hub.example";
const MiB = 1024 * 1024;

/** A body of 32 MiB of spaces, streamed in 64 KiB chunks, that counts how much of it was pulled. */
function endless(status = 200) {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= 32 * MiB) return c.close();
      pulled += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  return { res: new Response(body, { status, headers: { "content-type": "application/json" } }), pulled: () => pulled };
}

describe("a hub's answers are read under a cap", () => {
  it("a push reads the hub's marks and acknowledgements no further than the cap", async () => {
    const spoke = instanceEnv("s.example", await newFedKey(), { FED_HUB_URL: HUB, FED_SUBMIT_SECRET: "s" });
    await addCache(spoke);
    const bodies: { path: string; pulled: () => number }[] = [];
    const r = await pushToHub(spoke, (url) => {
      const e = endless();
      bodies.push({ path: new URL(url).pathname, pulled: e.pulled });
      return Promise.resolve(e.res);
    });
    expect(r?.failure).toBeUndefined();
    expect(bodies.map((b) => b.path)).toContain("/federation/submit/marks");
    expect(bodies.map((b) => b.path)).toContain("/federation/submit");
    for (const b of bodies) expect(b.pulled()).toBeLessThanOrEqual(MiB);
  });

  it("a relay poll reads the hub's lease no further than the cap", async () => {
    const spoke = instanceEnv("s.example", await newFedKey(), { FED_HUB_URL: HUB, FED_RELAY_SECRET: "r" });
    const e = endless();
    let asked = 0;
    stubFetch({
      [HUB]: () => {
        asked++;
        return Promise.resolve(e.res);
      },
    });
    await relayPoll(spoke);
    expect(asked).toBe(1);
    expect(e.pulled()).toBeLessThanOrEqual(4 * MiB);
  });

  it("collecting a relayed answer reads the hub's result no further than the cap, and waits for it", async () => {
    const asker = instanceEnv("a.example", await newFedKey());
    const peer = await newFedKey();
    await asker.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES ('https://p.example', 'p.example', ?, ?, 'trusted', 'manual')",
    )
      .bind(peer.pub, JSON.stringify([{ x: peer.pub }]))
      .run();
    const e = endless();
    stubFetch({ [HUB]: () => Promise.resolve(e.res) });
    const now = Math.floor(Date.now() / 1000);
    const ask = {
      url: "https://p.example",
      instance: "p.example",
      hub: HUB,
      id: 1,
      ticket: "t",
      nonce: "n",
      queryHash: "h",
      askedAt: now,
    };
    const q = { callsign: "OE8LOG", lat: 47.07, lon: 15.44, radiusM: 500, since: now - 3600, until: now };
    const r = await collectRelayed(asker, q, [ask], [], now);
    expect(e.pulled()).toBeLessThanOrEqual(9 * MiB);
    expect(r.waiting).toEqual([ask]);
  });

  it("a hub's relay ticket is read no further than the cap", async () => {
    const asker = instanceEnv("a.example", await newFedKey(), { FED_HUB_URL: HUB });
    const peer = await newFedKey();
    await asker.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES ('https://p.example', 'p.example', ?, ?, 'trusted', 'manual')",
    )
      .bind(peer.pub, JSON.stringify([{ x: peer.pub }]))
      .run();
    const e = endless(202);
    let relayAsked = 0;
    stubFetch({
      [HUB]: (req) => {
        expect(new URL(req.url).pathname).toBe("/federation/corroborate");
        relayAsked++;
        return Promise.resolve(e.res);
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const q = { callsign: "OE8LOG", lat: 47.07, lon: 15.44, radiusM: 500, since: now - 3600, until: now };
    const r = await askPeers(asker, q);
    expect(relayAsked).toBe(1);
    expect(e.pulled()).toBeLessThanOrEqual(MiB);
    expect(r.relayed).toEqual([]);
  });
});
