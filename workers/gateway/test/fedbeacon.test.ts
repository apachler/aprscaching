// SPDX-License-Identifier: AGPL-3.0-or-later
// The beacon tier end-to-end in miniature: an instance emits its signed presence datagram, a
// receiver that knows the instance hears it and refreshes the peer's self-attested endpoints, and a
// receiver that does NOT know it quarantines the frame — a beacon can never introduce a peer.
import { describe, it, expect, beforeAll } from "vitest";
import {
  decodeFedBeacon,
  decodeFedFrame,
  encodeFedBeacon,
  encodeFedSyncPage,
  encodeFedPayload,
  encodeFedFrame,
  fedSigningBytes,
  MAX_BEACON_BYTES,
  type FedRecord,
} from "@aprscaching/shared";
import { handleBeaconEmit, handleBeaconRx, handleFramesRx } from "../src/fedbeacon.js";
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

function rxDb(known: boolean, sinks: { endpointUpdates: unknown[][] }, hit = true) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM fed_peers")) return known ? { public_key: publicX, trust: "trusted" } : null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE fed_peers SET endpoints")) {
                sinks.endpointUpdates.push(args);
                return { meta: { changes: hit ? 1 : 0 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const rxPost = (payload: Uint8Array) =>
  new Request("http://gw/federation/beacon", {
    method: "POST",
    headers: { "x-ingest-secret": SECRET, "content-type": "application/octet-stream" },
    body: payload as BodyInit,
  });

describe("beacon tier: emit + trust-gated receive", () => {
  it("emits a signed presence datagram carrying the typed endpoint set", async () => {
    const env = {
      DB: rxDb(false, { endpointUpdates: [] }),
      INSTANCE: "oe.pub",
      FED_PRIVATE_KEY: keyEnvVal,
      FED_ENDPOINTS: '[{"transport":"44net","address":"oe8apr.ampr.org","priority":10}]',
    } as unknown as Env;
    const res = await handleBeaconEmit(new Request("http://gw/federation/beacon"), env);
    expect(res.status).toBe(200);
    const payload = new Uint8Array(await res.arrayBuffer());
    expect(payload.length).toBeLessThanOrEqual(MAX_BEACON_BYTES + 5);
    const frame = decodeFedBeacon(payload)!;
    const rec = decodeFedFrame(frame).record;
    expect(rec).toMatchObject({ kind: "peer", origin: "oe.pub", gid: "oe.pub:peer:announce" });
    expect(rec.body.addresses).toEqual([{ transport: "44net", address: "oe8apr.ampr.org", priority: 10 }]);
  });

  it("a receiver that knows the origin refreshes its endpoints; RX introduces no peer", async () => {
    const emitEnv = {
      DB: rxDb(false, { endpointUpdates: [] }),
      INSTANCE: "oe.pub",
      FED_PRIVATE_KEY: keyEnvVal,
      FED_ENDPOINTS: '[{"transport":"44net","address":"oe8apr.ampr.org","priority":10}]',
    } as unknown as Env;
    const payload = new Uint8Array(
      await (await handleBeaconEmit(new Request("http://gw/federation/beacon"), emitEnv)).arrayBuffer(),
    );

    // known origin: the pinned key verifies the frame, the endpoint set refreshes (UPDATE only)
    const knownSinks = { endpointUpdates: [] as unknown[][] };
    const known = { DB: rxDb(true, knownSinks), INSTANCE: "oe.sub", INGEST_SECRET: SECRET } as unknown as Env;
    const r1 = (await (await handleBeaconRx(rxPost(payload), known)).json()) as Record<string, number | boolean>;
    expect(r1).toMatchObject({ federation: true, applied: 1, quarantined: 0, rejected: 0 });
    expect(knownSinks.endpointUpdates).toHaveLength(1);
    expect(String(knownSinks.endpointUpdates[0]![1])).toBe("oe.pub");

    // unknown origin: quarantined, and no peer row appears
    const strangeSinks = { endpointUpdates: [] as unknown[][] };
    const stranger = { DB: rxDb(false, strangeSinks), INSTANCE: "oe.sub", INGEST_SECRET: SECRET } as unknown as Env;
    const r2 = (await (await handleBeaconRx(rxPost(payload), stranger)).json()) as Record<string, number | boolean>;
    expect(r2).toMatchObject({ federation: true, applied: 0, quarantined: 1 });
    expect(strangeSinks.endpointUpdates).toHaveLength(0);
  });

  it("non-beacon payloads and oversized bodies are refused without touching the pipeline", async () => {
    const env = {
      DB: rxDb(true, { endpointUpdates: [] }),
      INSTANCE: "oe.sub",
      INGEST_SECRET: SECRET,
    } as unknown as Env;
    const aprs = (await (
      await handleBeaconRx(rxPost(new TextEncoder().encode("!4707.35N/01526.27E-normal APRS")), env)
    ).json()) as { federation: boolean };
    expect(aprs.federation).toBe(false);
    const big = await handleBeaconRx(rxPost(new Uint8Array(8192)), env);
    expect(big.status).toBe(413);
  });

  it("a payload claiming to be a beacon but carrying junk frame bytes is rejected", async () => {
    const env = {
      DB: rxDb(true, { endpointUpdates: [] }),
      INSTANCE: "oe.sub",
      INGEST_SECRET: SECRET,
    } as unknown as Env;
    const junk = encodeFedBeacon(Uint8Array.from({ length: 40 }, (_, i) => i));
    const r = (await (await handleBeaconRx(rxPost(junk), env)).json()) as Record<string, number | boolean>;
    expect(r).toMatchObject({ federation: true, applied: 0, rejected: 1 });
  });
});

describe("connected-mode page delivery (/federation/frames)", () => {
  function tombDb(known: boolean, tombs: unknown[][]) {
    return {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM fed_peers")) return known ? { public_key: publicX, trust: "trusted" } : null;
                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                if (sql.includes("remote_tombstones")) tombs.push(args);
                return { meta: { changes: 1 } };
              },
              // the tombstone applier batches its delete + insert
            };
          },
        };
      },
      async batch(stmts: { run(): Promise<unknown> }[]) {
        for (const s of stmts) await s.run();
        return [];
      },
    };
  }
  const postPage = (bytes: Uint8Array) =>
    new Request("http://gw/federation/frames", {
      method: "POST",
      headers: { "x-ingest-secret": SECRET, "content-type": "application/cbor" },
      body: bytes as BodyInit,
    });

  it("verifies + applies the frames of a delivered page through the shared pipeline", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
    const record: FedRecord = {
      kind: "tombstone",
      gid: "oe.peer:tomb:1",
      origin: "oe.peer",
      v: 5,
      at: 1000,
      signer: "oe.peer",
      body: { kind: "cache", targetId: "oe.peer:cache:9", ts: 1000 },
    };
    const payload = encodeFedPayload(record);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, fedSigningBytes(payload)));
    const page = encodeFedSyncPage("oe.peer", 5, true, [encodeFedFrame(payload, pub, sig)]);

    const tombs: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM fed_peers")) return { public_key: pub, trust: "trusted" };
                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                if (sql.includes("remote_tombstones")) tombs.push(args);
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch(stmts: { run(): Promise<unknown> }[]) {
        for (const s of stmts) await s.run();
        return [];
      },
    };
    const env = { DB: db, INSTANCE: "oe.us", INGEST_SECRET: SECRET } as unknown as Env;
    const r = (await (await handleFramesRx(postPage(page), env)).json()) as Record<string, number | boolean>;
    expect(r).toMatchObject({ federation: true, frames: 1, applied: 1, quarantined: 0, rejected: 0 });
    expect(tombs).toHaveLength(1);
    expect(String(tombs[0]![0])).toBe("oe.peer:cache:9"); // the tombstone landed on its target
  });

  it("refuses a body that is not a CBOR page", async () => {
    const env = { DB: tombDb(false, []), INSTANCE: "oe.us", INGEST_SECRET: SECRET } as unknown as Env;
    const res = await handleFramesRx(postPage(new TextEncoder().encode("not cbor")), env);
    expect(res.status).toBe(400);
  });
});
