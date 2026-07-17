// SPDX-License-Identifier: AGPL-3.0-or-later
// The rendezvous relay's packet leg: the hub packs a spoke's queued queries into an ACSFED bulletin
// of signed relayQuery frames (dispatch), the spoke answers off the same store-and-forward receive
// with signed relayAnswer frames, and the hub lands the answer in its relay queue. The frame
// signatures bind both directions to their instances — no relay secret rides the carrier.
//
// The instance signing key is memoized process-wide, so hub and spoke share one keypair here (each
// pins it for the other); refusing a WRONG key is covered by the receive tests.
import { describe, it, expect, beforeAll } from "vitest";
import { decodeFedBbsBatch, decodeFedFrame, decodeFedSyncPage } from "@aprsweb/shared";
import { handleRelayDispatch } from "../src/relay.js";
import { applyFedBbsBulletin } from "../src/federation_sync.js";
import type { Env } from "../src/env.js";

const SECRET = "test-ingest-secret-0123456789";
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let publicX: string;
let keyEnvVal: string;
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicX = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  keyEnvVal = btoa(JSON.stringify({ pkcs8: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), pub: publicX }));
});

const cacheRow = {
  id: 7,
  code: "ACS-007",
  owner_call: "OE8APR",
  title: "Relayed Schlossberg",
  type: "traditional",
  status: "active",
  difficulty: 1,
  terrain: 1,
  lat: 47.07,
  lon: 15.44,
  station_call: null,
  source: "native",
  external_id: null,
  hint: null,
  description: null,
  min_trust: null,
  fed_scope: "public",
  created_at: 1000,
  updated_at: 2000,
};

interface Sinks {
  bbs: unknown[][]; // INSERT OR IGNORE INTO bbs_messages binds
  queueUpdates: unknown[][]; // UPDATE fed_relay_queue … binds
}

/** One mock DB for either role: relay-queue rows, the caches table, and capture sinks. */
function makeDb(
  opts: { queued?: { id: number; kind: string; params: string }[]; peerKey?: string; answerHit?: boolean },
  sinks: Sinks,
) {
  const stmt = (sql: string) => ({
    bind(...args: unknown[]) {
      return {
        async all() {
          if (sql.includes("FROM fed_relay_queue")) return { results: opts.queued ?? [] };
          if (sql.includes("FROM caches")) return { results: [cacheRow] };
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM fed_peers"))
            return opts.peerKey ? { public_key: opts.peerKey, trust: "trusted" } : null;
          return null;
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO bbs_messages")) {
            sinks.bbs.push(args);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE fed_relay_queue")) {
            sinks.queueUpdates.push(args);
            return { meta: { changes: opts.answerHit === false ? 0 : 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  });
  return {
    prepare: stmt,
    async batch(stmts: { run(): Promise<unknown> }[]) {
      for (const s of stmts) await s.run();
      return [];
    },
  };
}

const post = (url: string) =>
  new Request(url, { method: "POST", headers: { "x-ingest-secret": SECRET, "content-type": "application/json" } });

describe("rendezvous relay over the FBB carrier", () => {
  it("hub → spoke → hub: dispatch, answer off the receive path, landed answer", async () => {
    // hub: two queued queries for the spoke become one bulletin of signed relayQuery frames
    const hubSinks: Sinks = { bbs: [], queueUpdates: [] };
    const hubEnv = {
      DB: makeDb(
        { queued: [{ id: 7, kind: "feed", params: '{"feed":"caches","since":0}' }], peerKey: publicX },
        hubSinks,
      ),
      INSTANCE: "oe.hub",
      FED_PRIVATE_KEY: keyEnvVal,
      INGEST_SECRET: SECRET,
    } as unknown as Env;
    const disp = await handleRelayDispatch(post("http://gw/federation/relay/oe.spoke/dispatch"), hubEnv, "oe.spoke");
    expect(disp.status).toBe(200);
    const d = (await disp.json()) as { ok: boolean; dispatched: number; bid: string };
    expect(d).toMatchObject({ ok: true, dispatched: 1 });
    expect(hubSinks.queueUpdates.length).toBe(1); // marked leased
    const queryBody = String(hubSinks.bbs[0]![4]);
    const frames = decodeFedBbsBatch(queryBody)!.frames;
    expect(frames).toHaveLength(1);
    expect(decodeFedFrame(frames[0]!).record).toMatchObject({ kind: "relayQuery", origin: "oe.hub" });

    // spoke: the bulletin arrives over the mesh; the receive path answers from the local DB and
    // enqueues a signed relayAnswer bulletin back
    const spokeSinks: Sinks = { bbs: [], queueUpdates: [] };
    const spokeEnv = {
      DB: makeDb({ peerKey: publicX }, spokeSinks),
      INSTANCE: "oe.spoke",
      FED_PRIVATE_KEY: keyEnvVal,
    } as unknown as Env;
    const applied = await applyFedBbsBulletin(spokeEnv, queryBody);
    expect(applied).toMatchObject({ federation: true, applied: 1, quarantined: 0, rejected: 0 });
    expect(spokeSinks.bbs).toHaveLength(1);
    const answerBody = String(spokeSinks.bbs[0]![4]);
    const aRec = decodeFedFrame(decodeFedBbsBatch(answerBody)!.frames[0]!).record;
    expect(aRec).toMatchObject({ kind: "relayAnswer", origin: "oe.spoke" });
    expect(aRec.body.target).toBe("oe.hub");
    const result = JSON.parse(String(aRec.body.resultJson)) as { ok: boolean; data?: { pageB64?: string } };
    expect(result.ok).toBe(true);
    // the answer carries a CBOR page of signed frames — the spoke's cache rides inside it
    const pageBytes = Uint8Array.from(atob(String(result.data?.pageB64)), (c) => c.charCodeAt(0));
    expect(decodeFedSyncPage(pageBytes).frames).toHaveLength(1);

    // hub: the answer bulletin arrives; the queue row for (id, answering instance) is answered
    const backSinks: Sinks = { bbs: [], queueUpdates: [] };
    const hubEnv2 = {
      DB: makeDb({ peerKey: publicX }, backSinks),
      INSTANCE: "oe.hub",
      FED_PRIVATE_KEY: keyEnvVal,
    } as unknown as Env;
    const landed = await applyFedBbsBulletin(hubEnv2, answerBody);
    expect(landed).toMatchObject({ federation: true, applied: 1, quarantined: 0, rejected: 0 });
    expect(backSinks.queueUpdates).toHaveLength(1);
    const [answerJson, , id, instance] = backSinks.queueUpdates[0]! as [string, number, number, string];
    expect(id).toBe(7);
    expect(instance).toBe("oe.spoke"); // scoped to the ANSWERING instance's rows only
    expect((JSON.parse(answerJson) as { ok: boolean }).ok).toBe(true);
  });

  it("a relay frame addressed to another instance is neither applied nor rejected", async () => {
    const hubSinks: Sinks = { bbs: [], queueUpdates: [] };
    const hubEnv = {
      DB: makeDb({ queued: [{ id: 9, kind: "feed", params: "{}" }], peerKey: publicX }, hubSinks),
      INSTANCE: "oe.hub",
      FED_PRIVATE_KEY: keyEnvVal,
      INGEST_SECRET: SECRET,
    } as unknown as Env;
    await handleRelayDispatch(post("http://gw/federation/relay/oe.spoke/dispatch"), hubEnv, "oe.spoke");
    const body = String(hubSinks.bbs[0]![4]);

    // a third instance sees the flood: target mismatch → ignored, no answer enqueued
    const sinks: Sinks = { bbs: [], queueUpdates: [] };
    const other = {
      DB: makeDb({ peerKey: publicX }, sinks),
      INSTANCE: "oe.other",
      FED_PRIVATE_KEY: keyEnvVal,
    } as unknown as Env;
    const res = await applyFedBbsBulletin(other, body);
    expect(res).toMatchObject({ applied: 0, rejected: 0, quarantined: 0 });
    expect(sinks.bbs).toHaveLength(0);
  });

  it("an answer with no matching queue row is rejected, not silently absorbed", async () => {
    // build a real answer by driving the spoke, then land it on a hub whose queue has no such row
    const hubSinks: Sinks = { bbs: [], queueUpdates: [] };
    const hubEnv = {
      DB: makeDb({ queued: [{ id: 5, kind: "feed", params: "{}" }], peerKey: publicX }, hubSinks),
      INSTANCE: "oe.hub",
      FED_PRIVATE_KEY: keyEnvVal,
      INGEST_SECRET: SECRET,
    } as unknown as Env;
    await handleRelayDispatch(post("http://gw/federation/relay/oe.spoke/dispatch"), hubEnv, "oe.spoke");
    const spokeSinks: Sinks = { bbs: [], queueUpdates: [] };
    const spokeEnv = {
      DB: makeDb({ peerKey: publicX }, spokeSinks),
      INSTANCE: "oe.spoke",
      FED_PRIVATE_KEY: keyEnvVal,
    } as unknown as Env;
    await applyFedBbsBulletin(spokeEnv, String(hubSinks.bbs[0]![4]));

    const sinks: Sinks = { bbs: [], queueUpdates: [] };
    const emptyHub = {
      DB: makeDb({ peerKey: publicX, answerHit: false }, sinks),
      INSTANCE: "oe.hub",
      FED_PRIVATE_KEY: keyEnvVal,
    } as unknown as Env;
    const res = await applyFedBbsBulletin(emptyHub, String(spokeSinks.bbs[0]![4]));
    expect(res).toMatchObject({ applied: 0, rejected: 1 });
  });
});
