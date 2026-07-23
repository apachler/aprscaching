// SPDX-License-Identifier: AGPL-3.0-or-later
// The store-and-forward receive path: a federation bulletin that arrived over the FBB mesh is
// verified against its CLAIMED ORIGIN's keys and applied by gid — the same namespace/trust rules as
// an HTTP pull. Frames from an unknown or blocked origin are quarantined; a forged signature or a
// namespace violation is rejected; a bulletin flooded twice converges idempotently.
import { describe, it, expect, beforeAll } from "vitest";
import {
  encodeFedBbsBatch,
  encodeFedPayload,
  encodeFedFrame,
  fedSigningBytes,
  type FedRecord,
} from "@aprscaching/shared";
import { applyFedBbsBulletin } from "../src/federation_sync.js";
import { stableStringify } from "../src/federation.js";
import type { Env } from "../src/env.js";

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function mintKey() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, pub };
}

let peer: Awaited<ReturnType<typeof mintKey>>;
let attacker: Awaited<ReturnType<typeof mintKey>>;

beforeAll(async () => {
  peer = await mintKey();
  attacker = await mintKey();
});

/**
 * Sign a cache frame with `signer`'s actual keypair, claiming `origin` and `gid`. Signing directly
 * (not via signFedRecord) sidesteps the process-global instance-key memo, so a test can mint frames
 * from several distinct peers — the exact multi-instance case store-and-forward must handle.
 */
async function cacheFrame(
  signer: { kp: CryptoKeyPair; pub: string },
  origin: string,
  gid: string,
): Promise<Uint8Array> {
  const record: FedRecord = {
    kind: "cache",
    gid,
    origin,
    v: 1,
    at: 1000,
    signer: origin,
    body: { code: "ACS-1", title: "Schlossberg", status: "active", latE7: 471000000, lonE7: 152000000 },
  };
  const payload = encodeFedPayload(record);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", signer.kp.privateKey, fedSigningBytes(payload)));
  return encodeFedFrame(payload, signer.pub, sig);
}

/** A mock DB: fed_peers lookups return `peers[instance]`; remote_caches upserts land in `sink`. */
function makeDb(peers: Record<string, { public_key: string | null; trust: string }>, sink: { gid: string }[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM fed_peers")) return peers[String(args[0])] ?? null;
              return null; // tombstone checks etc. → absent
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO remote_caches")) sink.push({ gid: String(args[0]) });
              return {};
            },
          };
        },
      };
    },
  };
}

const recv = (db: unknown) => ({ DB: db, INSTANCE: "oe.us" }) as unknown as Env;

describe("fed-over-BBS receive: trust-gated apply", () => {
  it("applies frames from a known peer, verified against its pinned key", async () => {
    const frames = [
      await cacheFrame(peer, "oe.peer", "oe.peer:cache:1"),
      await cacheFrame(peer, "oe.peer", "oe.peer:cache:2"),
    ];
    const { body } = encodeFedBbsBatch(frames);
    const sink: { gid: string }[] = [];
    const res = await applyFedBbsBulletin(
      recv(makeDb({ "oe.peer": { public_key: peer.pub, trust: "trusted" } }, sink)),
      body,
    );
    expect(res).toMatchObject({ federation: true, applied: 2, quarantined: 0, rejected: 0 });
    expect(sink.map((r) => r.gid)).toEqual(["oe.peer:cache:1", "oe.peer:cache:2"]);
  });

  it("quarantines an origin it has no key for (unknown peer, no registry binding)", async () => {
    const { body } = encodeFedBbsBatch([await cacheFrame(peer, "oe.stranger", "oe.stranger:cache:1")]);
    const sink: { gid: string }[] = [];
    const res = await applyFedBbsBulletin(recv(makeDb({}, sink)), body);
    expect(res).toMatchObject({ applied: 0, quarantined: 1, rejected: 0 });
    expect(sink).toHaveLength(0);
  });

  it("quarantines a blocked peer even though its signature is valid", async () => {
    const { body } = encodeFedBbsBatch([await cacheFrame(peer, "oe.peer", "oe.peer:cache:1")]);
    const sink: { gid: string }[] = [];
    const res = await applyFedBbsBulletin(
      recv(makeDb({ "oe.peer": { public_key: peer.pub, trust: "blocked" } }, sink)),
      body,
    );
    expect(res).toMatchObject({ applied: 0, quarantined: 1 });
  });

  it("rejects a frame signed by a key outside the claimed origin's set (impersonation)", async () => {
    // attacker holds its own key but claims to be oe.peer — the key binding refuses it
    const { body } = encodeFedBbsBatch([await cacheFrame(attacker, "oe.peer", "oe.peer:cache:1")]);
    const sink: { gid: string }[] = [];
    const res = await applyFedBbsBulletin(
      recv(makeDb({ "oe.peer": { public_key: peer.pub, trust: "trusted" } }, sink)),
      body,
    );
    expect(res).toMatchObject({ applied: 0, rejected: 1, quarantined: 0 });
  });

  it("rejects a frame whose gid escapes the origin's namespace", async () => {
    const { body } = encodeFedBbsBatch([await cacheFrame(peer, "oe.peer", "victim:cache:9")]);
    const sink: { gid: string }[] = [];
    const res = await applyFedBbsBulletin(
      recv(makeDb({ "oe.peer": { public_key: peer.pub, trust: "trusted" } }, sink)),
      body,
    );
    expect(res).toMatchObject({ applied: 0, rejected: 1 });
  });

  it("never mirrors a frame claiming our own instance back in", async () => {
    const { body } = encodeFedBbsBatch([await cacheFrame(peer, "oe.us", "oe.us:cache:1")]);
    const sink: { gid: string }[] = [];
    const res = await applyFedBbsBulletin(
      recv(makeDb({ "oe.us": { public_key: peer.pub, trust: "trusted" } }, sink)),
      body,
    );
    expect(res).toMatchObject({ applied: 0, rejected: 1 });
  });

  it("bootstraps a peer from the signed registry binding when there is no pinned row yet", async () => {
    // sign a registry that binds oe.peer -> peer.pub, authority-signed
    const auth = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const authX = b64url(await crypto.subtle.exportKey("raw", auth.publicKey));
    const entries = [{ instance: "oe.peer", key: peer.pub }];
    const at = 100;
    const sig = b64url(
      await crypto.subtle.sign("Ed25519", auth.privateKey, new TextEncoder().encode(stableStringify({ at, entries }))),
    );
    const env = {
      DB: makeDb({}, []),
      INSTANCE: "oe.us",
      FED_REGISTRY: JSON.stringify({ entries, at, sig }),
      FED_REGISTRY_KEY: authX,
    } as unknown as Env;
    const { body } = encodeFedBbsBatch([await cacheFrame(peer, "oe.peer", "oe.peer:cache:1")]);
    const res = await applyFedBbsBulletin(env, body);
    expect(res).toMatchObject({ applied: 1, quarantined: 0, rejected: 0 });
  });

  it("returns federation:false for an ordinary BBS message", async () => {
    const res = await applyFedBbsBulletin(recv(makeDb({}, [])), "Hello de OE8APR\njust a normal bulletin");
    expect(res).toEqual({ federation: false, bid: null, applied: 0, quarantined: 0, rejected: 0 });
  });

  it("applies idempotently when the same bulletin floods in twice (converges by gid)", async () => {
    const { body } = encodeFedBbsBatch([await cacheFrame(peer, "oe.peer", "oe.peer:cache:1")]);
    const peers = { "oe.peer": { public_key: peer.pub, trust: "trusted" } };
    const sink: { gid: string }[] = [];
    const first = await applyFedBbsBulletin(recv(makeDb(peers, sink)), body);
    const second = await applyFedBbsBulletin(recv(makeDb(peers, sink)), body);
    expect(first.bid).toBe(second.bid); // same content-addressed BID → the mesh dedups on it
    expect(first.applied).toBe(1);
    expect(second.applied).toBe(1); // re-apply is safe: the appliers upsert by gid
  });
});
