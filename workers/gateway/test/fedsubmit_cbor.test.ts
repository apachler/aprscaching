// SPDX-License-Identifier: AGPL-3.0-or-later
// The CBOR wire on the push paths: a spoke submits a sync page of signed fedwire frames to a hub
// (one submission, one key — a smuggled second key is rejected), the spoke prefers CBOR and falls
// back to JSON for an older hub, and a relay feed answer can carry a CBOR page instead of
// JSON-signed items.
import { describe, it, expect, beforeAll } from "vitest";
import {
  encodeFedSyncPage,
  decodeFedSyncPage,
  encodeFedPayload,
  encodeFedFrame,
  fedSigningBytes,
  type FedRecord,
} from "@aprsweb/shared";
import { handleFederationSubmit, pushToHub } from "../src/federation_sync.js";
import { feedSource } from "../src/relay.js";
import type { Env } from "../src/env.js";

const SECRET = "test-fed-submit-secret-0123456789";
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let kp: CryptoKeyPair;
let publicX: string;
let keyEnvVal: string;
let attacker: CryptoKeyPair;
beforeAll(async () => {
  kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicX = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  keyEnvVal = btoa(JSON.stringify({ pkcs8: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), pub: publicX }));
  attacker = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
});

async function cacheFrame(signer: CryptoKeyPair, signerPub: string, origin: string, gid: string): Promise<Uint8Array> {
  const record: FedRecord = {
    kind: "cache",
    gid,
    origin,
    v: 1,
    at: 1000,
    signer: origin,
    body: { code: "ACS-1", title: "Pushed", status: "active", latE7: 470000000, lonE7: 152000000 },
  };
  const payload = encodeFedPayload(record);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", signer.privateKey, fedSigningBytes(payload)));
  return encodeFedFrame(payload, signerPub, sig);
}

function hubDb(sinks: { caches: string[]; peers: unknown[][] }) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return null; // no pinned submit key, no tombstones
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO remote_caches")) sinks.caches.push(String(args[0]));
              if (sql.includes("INSERT OR IGNORE INTO fed_peers")) sinks.peers.push(args);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const submitPost = (bytes: Uint8Array) =>
  new Request("http://gw/federation/submit", {
    method: "POST",
    headers: { "content-type": "application/cbor", "x-fed-secret": SECRET },
    body: bytes as BodyInit,
  });

describe("CBOR submit (push-to-hub wire)", () => {
  it("accepts a spoke's page, applies its frames, and pins the frame's key", async () => {
    const page = encodeFedSyncPage("oe.spoke", 1, true, [
      await cacheFrame(kp, publicX, "oe.spoke", "oe.spoke:cache:1"),
    ]);
    const sinks = { caches: [] as string[], peers: [] as unknown[][] };
    const env = { DB: hubDb(sinks), INSTANCE: "oe.hub", FED_SUBMIT_SECRET: SECRET } as unknown as Env;
    const r = (await (await handleFederationSubmit(submitPost(page), env)).json()) as Record<string, number | boolean>;
    expect(r).toMatchObject({ ok: true, applied: 1, rejected: 0 });
    expect(sinks.caches).toEqual(["oe.spoke:cache:1"]);
    expect(String(sinks.peers[0]![2])).toBe(publicX); // the registered spoke carries the submitting key
  });

  it("rejects a second key smuggled into the batch and any foreign-origin frame", async () => {
    const attackerPub = b64url(await crypto.subtle.exportKey("raw", attacker.publicKey));
    const page = encodeFedSyncPage("oe.spoke", 2, true, [
      await cacheFrame(kp, publicX, "oe.spoke", "oe.spoke:cache:1"),
      await cacheFrame(attacker, attackerPub, "oe.spoke", "oe.spoke:cache:2"), // different key
      await cacheFrame(kp, publicX, "oe.victim", "oe.victim:cache:3"), // foreign origin
    ]);
    const sinks = { caches: [] as string[], peers: [] as unknown[][] };
    const env = { DB: hubDb(sinks), INSTANCE: "oe.hub", FED_SUBMIT_SECRET: SECRET } as unknown as Env;
    const r = (await (await handleFederationSubmit(submitPost(page), env)).json()) as Record<string, number | boolean>;
    expect(r).toMatchObject({ ok: true, applied: 1, rejected: 2 });
    expect(sinks.caches).toEqual(["oe.spoke:cache:1"]);
  });

  it("refuses a body that is not a CBOR page", async () => {
    const env = {
      DB: hubDb({ caches: [], peers: [] }),
      INSTANCE: "oe.hub",
      FED_SUBMIT_SECRET: SECRET,
    } as unknown as Env;
    const res = await handleFederationSubmit(submitPost(new TextEncoder().encode("nope")), env);
    expect(res.status).toBe(400);
  });
});

const cacheRow = {
  id: 3,
  code: "ACS-3",
  owner_call: "OE8APR",
  title: "Pushed",
  type: "traditional",
  status: "active",
  difficulty: 1,
  terrain: 1,
  lat: 47,
  lon: 15.2,
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

function spokeDb() {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              return { results: sql.includes("FROM caches") ? [cacheRow] : [] };
            },
            async first() {
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

describe("pushToHub prefers CBOR, falls back to JSON", () => {
  it("pushes a CBOR page when the hub accepts it", async () => {
    const seen: { ct: string; body: Uint8Array }[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        ct: String((init?.headers as Record<string, string>)["content-type"]),
        body: new Uint8Array(init?.body as Uint8Array),
      });
      return new Response(JSON.stringify({ ok: true, applied: 1, rejected: 0 }));
    }) as typeof fetch;
    const env = {
      DB: spokeDb(),
      INSTANCE: "oe.spoke",
      FED_PRIVATE_KEY: keyEnvVal,
      FED_HUB_URL: "http://hub-cbor.test",
      FED_SUBMIT_SECRET: SECRET,
    } as unknown as Env;
    const r = await pushToHub(env, fetchFn);
    expect(r?.pushed).toBe(1);
    expect(seen[0]!.ct).toBe("application/cbor");
    const page = decodeFedSyncPage(seen[0]!.body);
    expect(page.instance).toBe("oe.spoke");
    expect(page.frames).toHaveLength(1);
  });

  it("drops to the JSON compatibility surface when the hub answers 400 to CBOR", async () => {
    const cts: string[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const ct = String((init?.headers as Record<string, string>)["content-type"]);
      cts.push(ct);
      if (ct.includes("cbor")) return new Response("bad", { status: 400 });
      return new Response(JSON.stringify({ ok: true, applied: 1, rejected: 0 }));
    }) as typeof fetch;
    const env = {
      DB: spokeDb(),
      INSTANCE: "oe.spoke",
      FED_PRIVATE_KEY: keyEnvVal,
      FED_HUB_URL: "http://hub-legacy.test",
      FED_SUBMIT_SECRET: SECRET,
    } as unknown as Env;
    const r = await pushToHub(env, fetchFn);
    expect(r?.pushed).toBe(1);
    expect(cts[0]).toContain("cbor");
    expect(cts[1]).toContain("json"); // the same page re-sent on the compatibility surface
  });
});

describe("relay feed answers in CBOR", () => {
  it("encoding=cbor answers with a base64 sync page of signed frames", async () => {
    const env = { DB: spokeDb(), INSTANCE: "oe.spoke", FED_PRIVATE_KEY: keyEnvVal } as unknown as Env;
    const r = (await feedSource(env, { feed: "caches", since: 0, encoding: "cbor" })) as {
      encoding: string;
      pageB64: string;
      complete: boolean;
    };
    expect(r.encoding).toBe("cbor");
    const bytes = Uint8Array.from(atob(r.pageB64), (c) => c.charCodeAt(0));
    const page = decodeFedSyncPage(bytes);
    expect(page.instance).toBe("oe.spoke");
    expect(page.frames).toHaveLength(1);
    expect(r.complete).toBe(true);
  });
});
