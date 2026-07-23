// SPDX-License-Identifier: AGPL-3.0-or-later
// The FBB store-and-forward carrier end-to-end in miniature: a publisher packs its local cache
// records into an ACSFED bulletin (/federation/bbs/enqueue), the bulletin rides the mesh as an
// ordinary BBS message, and a subscriber's forward-inbound hook verifies + applies its frames
// through the trust-gated receive. Same signed frames as HTTP sync — a different carrier.
import { describe, it, expect, beforeAll } from "vitest";
import { handleFedBbsEnqueue } from "../src/fedforward.js";
import { handleForwardInbound } from "../src/forward.js";
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
  id: 42,
  code: "ACS-042",
  owner_call: "OE8APR",
  title: "Schlossberg",
  type: "traditional",
  status: "active",
  difficulty: 1.5,
  terrain: 2,
  lat: 47.0832,
  lon: 15.4232,
  station_call: null,
  source: "native",
  external_id: null,
  hint: null,
  description: "at the top",
  min_trust: null,
  fed_scope: "public",
  created_at: 1000,
  updated_at: 2000,
};

/** Publisher DB: serves the cache row to the feed producer; captures the enqueued BBS bulletin. */
function publisherDb(bbsSink: unknown[][]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              return { results: sql.includes("FROM caches") ? [cacheRow] : [] };
            },
            async first() {
              return null;
            },
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO bbs_messages")) bbsSink.push(args);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

/** Subscriber DB: knows the publisher as a trusted peer; captures BBS store + remote_caches apply. */
function subscriberDb(caches: { gid: string }[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM fed_peers")) return { public_key: publicX, trust: "trusted" };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO remote_caches")) caches.push({ gid: String(args[0]) });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "x-ingest-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("FBB carrier: enqueue on the publisher, apply on the subscriber", () => {
  it("round-trips a cache record from local feed to a remote mirror via an ACSFED bulletin", async () => {
    // publisher: pack local cache records into one bulletin
    const bbsSink: unknown[][] = [];
    const pubEnv = {
      DB: publisherDb(bbsSink),
      INSTANCE: "oe.pub",
      FED_PRIVATE_KEY: keyEnvVal,
      FED_APRS_CALL: "OE8APR-12",
      INGEST_SECRET: SECRET,
    } as unknown as Env;
    const enq = await handleFedBbsEnqueue(post("http://gw/federation/bbs/enqueue", { types: ["cache"] }), pubEnv);
    expect(enq.status).toBe(200);
    const e = (await enq.json()) as { ok: boolean; bid: string; frames: number; enqueued: number };
    expect(e).toMatchObject({ ok: true, frames: 1, enqueued: 1 });
    expect(bbsSink).toHaveLength(1);
    const [bid, fromCall, toCall, , body] = bbsSink[0]! as [string, string, string, string, string];
    expect(bid).toBe(e.bid);
    expect(fromCall).toBe("OE8APR-12");
    expect(toCall).toBe("ACSFED");

    // subscriber: the same bulletin arrives over FBB forwarding; the inbound hook applies it
    const caches: { gid: string }[] = [];
    const subEnv = { DB: subscriberDb(caches), INSTANCE: "oe.sub", INGEST_SECRET: SECRET } as unknown as Env;
    const inb = await handleForwardInbound(
      post("http://gw/api/bbs/forward/inbound", {
        message: { bid, type: "B", from: fromCall, to: toCall, title: "federation batch (1)", body },
        origin: "rf-fbb",
      }),
      subEnv,
    );
    expect(inb.status).toBe(200);
    const r = (await inb.json()) as { stored: number; federation?: { applied: number; federation: boolean } };
    expect(r.stored).toBe(1);
    expect(r.federation).toMatchObject({ federation: true, applied: 1, quarantined: 0, rejected: 0 });
    expect(caches.map((c) => c.gid)).toEqual(["oe.pub:cache:42"]);
  });

  it("an already-enqueued bulletin (bid UNIQUE hit) reports deduped instead of double-posting", async () => {
    const env = {
      DB: {
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
                  return { meta: { changes: 0 } }; // bbs_messages.bid UNIQUE → INSERT OR IGNORE no-ops
                },
              };
            },
          };
        },
      },
      INSTANCE: "oe.pub",
      FED_PRIVATE_KEY: keyEnvVal,
      INGEST_SECRET: SECRET,
    } as unknown as Env;
    const r = (await (await handleFedBbsEnqueue(post("http://gw/x", { types: ["cache"] }), env)).json()) as {
      enqueued: number;
      deduped: boolean;
    };
    expect(r.enqueued).toBe(0);
    expect(r.deduped).toBe(true);
  });

  // The unsigned-instance branch (409) is not exercisable here: the instance key is memoized
  // process-wide on first successful load, and the round-trip test above has already loaded it.

  it("rejects a caller without the ingest secret or a sysop session", async () => {
    const env = { DB: publisherDb([]), INSTANCE: "oe.pub", INGEST_SECRET: SECRET } as unknown as Env;
    const res = await handleFedBbsEnqueue(
      new Request("http://gw/x", {
        method: "POST",
        headers: { "x-ingest-secret": "wrong", "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("an ordinary inbound bulletin is stored without triggering the federation path", async () => {
    const caches: { gid: string }[] = [];
    const env = { DB: subscriberDb(caches), INSTANCE: "oe.sub", INGEST_SECRET: SECRET } as unknown as Env;
    const res = await handleForwardInbound(
      post("http://gw/api/bbs/forward/inbound", {
        message: { bid: "1_OE8XBB", type: "B", from: "OE8APR", to: "ALL", title: "hi", body: "hello mesh" },
      }),
      env,
    );
    const r = (await res.json()) as { stored: number; federation?: unknown };
    expect(r.stored).toBe(1);
    expect(r.federation).toBeUndefined();
    expect(caches).toHaveLength(0);
  });
});
