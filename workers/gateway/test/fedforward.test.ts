// SPDX-License-Identifier: AGPL-3.0-or-later
// Federation over FBB end-to-end in miniature: a publisher packs its local cache records into an
// ACSFED batch (/federation/bbs/enqueue), the batch travels as personal mail to a partner marked for
// federation, and the subscriber's forward-inbound hook verifies + applies its frames through the
// trust-gated receive. Same signed frames as HTTP sync — a different carrier. Off unless FED_BBS is on.
import { describe, it, expect, beforeAll } from "vitest";
import { handleFedBbsEnqueue, enqueueAcsfedBulletin } from "../src/fedforward.js";
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
  fed_id: 42,
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

/**
 * Subscriber DB: knows the publisher as a trusted peer and OE1PUB-1 as the partner marked for federation;
 * captures BBS store + remote_caches apply. `stored` is the BID set bbs_messages holds (its UNIQUE index).
 */
function subscriberDb(caches: { gid: string }[], stored = new Set<string>(), fedPartners = ["OE1PUB-1"]) {
  return {
    prepare(sql: string) {
      const stmt = (...args: unknown[]) => ({
        async first() {
          if (sql.includes("FROM fed_peers")) return { public_key: publicX, trust: "trusted" };
          return null;
        },
        async all() {
          if (sql.includes("FROM bbs_partners WHERE federation = 1"))
            return { results: fedPartners.map((call) => ({ call, ha: null })) };
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO remote_caches")) caches.push({ gid: String(args[0]) });
          if (sql.includes("INTO bbs_messages")) {
            const bid = String(args[0]);
            if (stored.has(bid)) return { meta: { changes: 0 } };
            stored.add(bid);
          }
          return { meta: { changes: 1 } };
        },
      });
      return { bind: stmt, ...stmt() };
    },
  };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "x-ingest-secret": SECRET, "x-operator-secret": SECRET, "content-type": "application/json" },
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
      FED_OPERATOR: "OE8APR",
      FED_BBS: "1",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    const enq = await handleFedBbsEnqueue(post("http://gw/federation/bbs/enqueue", { types: ["cache"] }), pubEnv);
    expect(enq.status).toBe(200);
    const e = (await enq.json()) as { ok: boolean; bid: string; frames: number; enqueued: number };
    expect(e).toMatchObject({ ok: true, frames: 1, enqueued: 1 });
    expect(bbsSink).toHaveLength(1);
    const [bid, fromCall, toCall, , body] = bbsSink[0]! as [string, string, string, string, string];
    expect(bid).toBe(e.bid);
    expect(fromCall).toBe("OE8APR");
    expect(toCall).toBe("ACSFED");

    // subscriber: the same batch arrives over FBB forwarding from the marked partner; the inbound hook applies it
    const caches: { gid: string }[] = [];
    const stored = new Set<string>();
    const subEnv = {
      DB: subscriberDb(caches, stored),
      INSTANCE: "oe.sub",
      FED_BBS: "1",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    const deliver = () =>
      handleForwardInbound(
        post("http://gw/api/bbs/forward/inbound", {
          message: { bid, type: "P", from: fromCall, to: toCall, title: "federation batch (1)", body },
          origin: "rf-fbb:OE1PUB-1",
        }),
        subEnv,
      );
    const inb = await deliver();
    expect(inb.status).toBe(200);
    const r = (await inb.json()) as { stored: number; federation?: { applied: number; federation: boolean } };
    expect(r.stored).toBe(1);
    expect(r.federation).toMatchObject({ federation: true, applied: 1, quarantined: 0, rejected: 0 });
    expect(caches.map((c) => c.gid)).toEqual(["oe.pub:cache:42"]);

    // a second copy of the same batch dedups on its BID and is not applied again
    const again = (await (await deliver()).json()) as { stored: number; deduped: boolean; federation?: unknown };
    expect(again).toMatchObject({ stored: 0, deduped: true });
    expect(again.federation).toBeUndefined();
    expect(caches).toHaveLength(1);
  });

  it("stores the batch as personal mail to ACSFED, never as a bulletin", async () => {
    const sqls: string[] = [];
    const db = publisherDb([]);
    const env = {
      DB: { prepare: (sql: string) => (sqls.push(sql), db.prepare(sql)) },
      INSTANCE: "oe.pub",
      FED_PRIVATE_KEY: keyEnvVal,
      FED_BBS: "1",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    expect((await handleFedBbsEnqueue(post("http://gw/x", { types: ["cache"] }), env)).status).toBe(200);
    expect(sqls.find((q) => q.includes("INSERT OR IGNORE INTO bbs_messages"))).toContain("VALUES (?, 'P',");
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
      FED_BBS: "1",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
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

  it("rejects a caller without the operator secret or a sysop session", async () => {
    const env = {
      DB: publisherDb([]),
      INSTANCE: "oe.pub",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    const res = await handleFedBbsEnqueue(
      new Request("http://gw/x", {
        method: "POST",
        headers: { "x-operator-secret": "wrong", "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("an ordinary inbound bulletin is stored without triggering the federation path", async () => {
    const caches: { gid: string }[] = [];
    const env = {
      DB: subscriberDb(caches),
      INSTANCE: "oe.sub",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
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

describe("federation over FBB is off by default and partner-only", () => {
  /** A signed one-record batch, as the publisher would enqueue it. */
  async function batch(): Promise<{ bid: string; body: string }> {
    const sink: unknown[][] = [];
    const pubEnv = {
      DB: publisherDb(sink),
      INSTANCE: "oe.pub",
      FED_PRIVATE_KEY: keyEnvVal,
      FED_BBS: "1",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    await handleFedBbsEnqueue(post("http://gw/x", { types: ["cache"] }), pubEnv);
    const [bid, , , , body] = sink[0]! as [string, string, string, string, string];
    return { bid, body };
  }

  it("refuses to enqueue while FED_BBS is unset, and stores nothing", async () => {
    const sink: unknown[][] = [];
    const env = {
      DB: publisherDb(sink),
      INSTANCE: "oe.pub",
      FED_PRIVATE_KEY: keyEnvVal,
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    const res = await handleFedBbsEnqueue(post("http://gw/x", { types: ["cache"] }), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/FED_BBS/);
    expect(sink).toHaveLength(0);
  });

  it("the shared enqueue throws while FED_BBS is off, so no automatic path can queue a batch", async () => {
    const env = { DB: publisherDb([]), INSTANCE: "oe.pub" } as unknown as Env;
    await expect(enqueueAcsfedBulletin(env, [new Uint8Array([1])])).rejects.toThrow(/FED_BBS/);
  });

  it("drops an arriving batch unstored and unapplied while FED_BBS is off", async () => {
    const { bid, body } = await batch();
    const caches: { gid: string }[] = [];
    const stored = new Set<string>();
    const env = {
      DB: subscriberDb(caches, stored),
      INSTANCE: "oe.sub",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    const res = await handleForwardInbound(
      post("http://gw/api/bbs/forward/inbound", {
        message: { bid, type: "P", from: "OE8APR", to: "ACSFED", body },
        origin: "rf-fbb:OE1PUB-1",
      }),
      env,
    );
    const r = (await res.json()) as { stored: number; ignored?: string; federation?: unknown };
    expect(r).toMatchObject({ stored: 0, ignored: "federation over FBB is off" });
    expect(r.federation).toBeUndefined();
    expect(stored.size).toBe(0);
    expect(caches).toHaveLength(0);
  });

  it("drops a batch from a partner not marked for federation, as personal mail or as a bulletin", async () => {
    const { bid, body } = await batch();
    const caches: { gid: string }[] = [];
    const stored = new Set<string>();
    const env = {
      DB: subscriberDb(caches, stored),
      INSTANCE: "oe.sub",
      FED_BBS: "1",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    for (const [type, origin] of [
      ["P", "rf-fbb:OE9XYZ-1"],
      ["B", "rf-fbb:OE9XYZ-1"],
      ["P", "rf-fbb"],
    ]) {
      const r = (await (
        await handleForwardInbound(
          post("http://gw/api/bbs/forward/inbound", {
            message: { bid, type, from: "OE8APR", to: "ACSFED", body },
            origin,
          }),
          env,
        )
      ).json()) as { stored: number; ignored?: string };
      expect(r, `${type} via ${origin}`).toMatchObject({
        stored: 0,
        ignored: "the partner is not marked for federation",
      });
    }
    expect(stored.size).toBe(0);
    expect(caches).toHaveLength(0);
  });

  it("takes a batch from the marked partner calling in under another SSID", async () => {
    const { bid, body } = await batch();
    const caches: { gid: string }[] = [];
    const env = {
      DB: subscriberDb(caches),
      INSTANCE: "oe.sub",
      FED_BBS: "1",
      INGEST_SECRET: SECRET,
      OPERATOR_SECRET: SECRET,
    } as unknown as Env;
    const r = (await (
      await handleForwardInbound(
        post("http://gw/api/bbs/forward/inbound", {
          message: { bid, type: "P", from: "OE8APR", to: "ACSFED", body },
          origin: "rf-fbb:OE1PUB",
        }),
        env,
      )
    ).json()) as { stored: number };
    expect(r.stored).toBe(1);
    expect(caches).toHaveLength(1);
  });
});
