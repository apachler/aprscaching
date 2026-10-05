// SPDX-License-Identifier: AGPL-3.0-or-later
// Replay and robustness of the federation layer over real instances: records only move forward,
// sync pages carry only their own record type, notify can't be used to drive syncs, discovery can't
// reach private networks or grow without bound, carrier ids can't be squatted, bodies are capped,
// and relay spokes are isolated by their own keys.
import { describe, it, expect, afterEach, vi } from "vitest";
import { encodeFedSyncPage, encodeFedBbsBatch } from "@aprscaching/shared";
import { syncAllPeers, applyFedFrames } from "@aprscaching/gateway/federation_sync";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import { gossipDue } from "@aprscaching/gateway/gossip";
import { validEndpointAddress } from "@aprscaching/shared";
import { makeFetchGuard } from "../src/fetchguard.js";
import {
  newFedKey,
  instanceEnv,
  addCache,
  serve,
  stubFetch,
  peerRow,
  type FedKey,
  type Serve,
} from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const A = "https://a.example";
const nowS = () => Math.floor(Date.now() / 1000);

async function pair(hubExtra: Record<string, unknown> = {}) {
  const key = await newFedKey();
  const a = instanceEnv("a.example", key);
  const hub = instanceEnv("hub.example", await newFedKey(), hubExtra);
  await hub.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, 'a.example', ?, ?, 'trusted', 'manual')",
  )
    .bind(A, key.pub, JSON.stringify([{ x: key.pub }]))
    .run();
  return { key, a, hub };
}

const frame = (env: Env, kind: string, gid: string, v: number, body: Record<string, unknown>, at = nowS()) =>
  signFedRecord(env, { kind: kind as never, gid, origin: "a.example", v, at, signer: "a.example", body }).then(
    (f) => f!,
  );

const page = (frames: Uint8Array[], next = 1) =>
  new Response(encodeFedSyncPage("a.example", next, true, frames) as BodyInit, {
    headers: { "content-type": "application/cbor" },
  });

describe("records only move forward", () => {
  it("replaying an older key record does not roll the mirror back", async () => {
    const { a, hub } = await pair();
    const k = (v: number, pk: string) => frame(a, "key", "a.example:key:1", v, { callsign: "OE8K", publicKey: pk });
    expect((await applyFedFrames(hub, [await k(5, "NEW")])).applied).toBe(1);
    await applyFedFrames(hub, [await k(3, "OLD")]);
    const row = await hub.DB.prepare("SELECT public_key FROM remote_keys").first<{ public_key: string }>();
    expect(row?.public_key).toBe("NEW");
  });

  it("an equal version with other content does not overwrite", async () => {
    const { a, hub } = await pair();
    const c = (title: string) =>
      frame(a, "cache", "a.example:cache:1", 1000, { code: "AC-1", title, status: "active", updatedAt: 1000 });
    await applyFedFrames(hub, [await c("genuine")]);
    await applyFedFrames(hub, [await c("forged at the same version")]);
    const row = await hub.DB.prepare("SELECT title FROM remote_caches").first<{ title: string }>();
    expect(row?.title).toBe("genuine");
  });

  it("a far-future timestamp version is refused, so it cannot freeze the mirror", async () => {
    const { a, hub } = await pair();
    const far = nowS() + 10 * 365 * 86400;
    const b = (subject: string, v: number) =>
      frame(a, "bulletin", "a.example:bulletin:1", v, {
        fromCall: "OE8APR",
        toCall: "ALL",
        subject,
        body: "text",
        postedAt: v,
      });
    expect((await applyFedFrames(hub, [await b("from the future", far)])).applied).toBe(0);
    expect((await applyFedFrames(hub, [await b("today", nowS())])).applied).toBe(1);
  });

  it("a far-future updatedAt is clamped to the clock", async () => {
    const { a, hub } = await pair();
    const far = nowS() + 10 * 365 * 86400;
    await applyFedFrames(hub, [
      await frame(a, "cache", "a.example:cache:1", 2 ** 32, {
        code: "AC-1",
        title: "t",
        status: "active",
        updatedAt: far,
      }),
    ]);
    const row = await hub.DB.prepare("SELECT updated_at FROM remote_caches").first<{ updated_at: number }>();
    expect(row!.updated_at).toBeLessThanOrEqual(nowS() + 300);
  });

  it("a frame signed in the future is refused", async () => {
    const { a, hub } = await pair();
    const f = await frame(a, "key", "a.example:key:2", 2, { callsign: "OE8K", publicKey: "PK" }, nowS() + 3600);
    expect((await applyFedFrames(hub, [f])).applied).toBe(0);
  });

  it("a replayed relay query is answered once", async () => {
    const { a, hub } = await pair({ FED_BBS: "1" }); // the answer goes back over FBB
    const q = await frame(a, "relayQuery", "a.example:relay:7", nowS(), {
      id: 7,
      target: "hub.example",
      kind: "feed",
      paramsJson: JSON.stringify({ feed: "caches" }),
    });
    await applyFedFrames(hub, [q]);
    await applyFedFrames(hub, [q]);
    const n = await hub.DB.prepare("SELECT COUNT(*) AS n FROM bbs_messages WHERE to_call = 'ACSFED'").first<{
      n: number;
    }>();
    expect(n?.n).toBe(1);
  });

  it("a local cache edited twice in one second is served at a strictly higher version", async () => {
    const { decodeFedFrame } = await import("@aprscaching/shared");
    const a = instanceEnv("a.example", await newFedKey());
    const id = await addCache(a, 5000);
    const v = async () => {
      const { servedFrames } = await import("./helpers/fedpeer.js");
      return decodeFedFrame((await servedFrames(a))[0]!).record.v;
    };
    const before = await v();
    await a.DB.prepare("UPDATE caches SET title = 'x' WHERE id = ?").bind(id).run();
    await a.DB.prepare("UPDATE caches SET title = 'y' WHERE id = ?").bind(id).run();
    expect(await v()).toBe(before + 2);
    const r = await a.DB.prepare("SELECT updated_at FROM caches WHERE id = ?").bind(id).first<{ updated_at: number }>();
    expect(r?.updated_at).toBe(5000); // the cursor timestamp is never pushed ahead
  });
});

describe("a sync page carries only its own record type", () => {
  it("does not apply a key frame served on the cache page", async () => {
    const { a, hub } = await pair();
    const keyFrame = await frame(a, "key", "a.example:key:9", 9, { callsign: "OE8K", publicKey: "PK" });
    const inner = serve(a);
    stubFetch({
      [A]: (req) =>
        new URL(req.url).pathname === "/federation/sync/cache" ? Promise.resolve(page([keyFrame])) : inner(req),
    });
    await syncAllPeers(hub);
    const n = await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_keys WHERE global_id = 'a.example:key:9'").first<{
      n: number;
    }>();
    expect(n?.n).toBe(0);
  });
});

describe("notify", () => {
  const notify = (env: Env, instance: string, ip = "198.51.100.1") =>
    serve(env)(
      new Request("https://hub.example/federation/notify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: JSON.stringify({ instance }),
      }),
    );

  it("ignores an instance it does not follow, without touching the network", async () => {
    const hub = instanceEnv("hub.example", await newFedKey());
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: RequestInfo | URL) => {
      calls.push(String(u));
      return new Response("", { status: 500 });
    });
    const r = await notify(hub, "stranger.example");
    expect(((await r.json()) as { ignored?: string }).ignored).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("rate-limits one host hammering notify", async () => {
    const { hub } = await pair();
    stubFetch({});
    let limited = 0;
    for (let i = 0; i < 130; i++) if ((await notify(hub, `x${i}.example`, "198.51.100.9")).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it("keeps its cooldown map bounded", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 5000; i++) gossipDue(`pull:${i}.example`, i * 10_000, m);
    expect(m.size).toBeLessThanOrEqual(1024);
  });
});

describe("discovery", () => {
  it("an https endpoint must be https", () => {
    expect(validEndpointAddress("https", "https://a.example")).toBe(true);
    expect(validEndpointAddress("https", "http://a.example")).toBe(false);
  });

  it("learns only https peers from trusted peers, adds them disabled, and caps the total", async () => {
    const { a, hub } = await pair({ FED_DISCOVER: "1" });
    const advertised = [
      "https://ok.example",
      "http://10.0.0.1",
      "javascript:alert(1)",
      ...Array.from({ length: 400 }, (_, i) => `https://p${i}.example`),
    ];
    const inner = serve(a);
    stubFetch({
      [A]: async (req) => {
        const res = await inner(req);
        if (new URL(req.url).pathname !== "/.well-known/aprscaching") return res;
        return Response.json({ ...((await res.json()) as object), peers: advertised });
      },
    });
    await syncAllPeers(hub);
    await syncAllPeers(hub);
    const rows = (
      await hub.DB.prepare("SELECT url, enabled FROM fed_peers WHERE added_via = 'discovered'").all<{
        url: string;
        enabled: number;
      }>()
    ).results;
    expect(rows.some((r) => r.url === "https://ok.example")).toBe(true);
    expect(rows.some((r) => !r.url.startsWith("https://"))).toBe(false);
    expect(rows.every((r) => r.enabled === 0)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(200);
  });

  it("FED_DISCOVER=0 learns nothing", async () => {
    const { a, hub } = await pair({ FED_DISCOVER: "0" });
    const inner = serve(a);
    stubFetch({
      [A]: async (req) => {
        const res = await inner(req);
        if (new URL(req.url).pathname !== "/.well-known/aprscaching") return res;
        return Response.json({ ...((await res.json()) as object), peers: ["https://learned.example"] });
      },
    });
    await syncAllPeers(hub);
    expect(await peerRow(hub, "https://learned.example")).toBeNull();
  });

  it("an unvetted peer's advertised peers are ignored", async () => {
    const { a, hub } = await pair({ FED_DISCOVER: "1" });
    await hub.DB.prepare("UPDATE fed_peers SET trust = 'unvetted' WHERE url = ?").bind(A).run();
    const inner = serve(a);
    stubFetch({
      [A]: async (req) => {
        const res = await inner(req);
        if (new URL(req.url).pathname !== "/.well-known/aprscaching") return res;
        return Response.json({ ...((await res.json()) as object), peers: ["https://learned.example"] });
      },
    });
    await syncAllPeers(hub);
    expect(await peerRow(hub, "https://learned.example")).toBeNull();
  });
});

describe("the Node fetch guard", () => {
  const guard = makeFetchGuard({ allowedOrigins: ["http://127.0.0.1:8801"] });
  for (const u of [
    "http://127.0.0.1:9/x",
    "http://10.1.2.3/",
    "http://[::1]/",
    "http://169.254.169.254/",
    "http://localhost/",
  ])
    it(`refuses ${u}`, async () => {
      await expect(guard(u)).rejects.toThrow(/private|loopback|link-local|refused/);
    });
  it("allows an origin the operator configured, and public addresses", async () => {
    await expect(guard("http://127.0.0.1:8801/federation/sync/cache")).resolves.toBeUndefined();
    await expect(guard("https://1.1.1.1/")).resolves.toBeUndefined();
  });
  it("refuses a non-http scheme", async () => {
    await expect(guard("file:///etc/passwd")).rejects.toThrow(/scheme/);
  });
});

describe("carrier ids and body caps", () => {
  it("refuses an ACSFED bulletin whose BID does not match its content", async () => {
    const { a, hub } = await pair({ FED_BBS: "1" });
    await hub.DB.prepare("INSERT INTO bbs_partners (call, federation) VALUES ('OE1PRT-1', 1)").run();
    const f = await frame(a, "key", "a.example:key:1", 1, { callsign: "OE8K", publicKey: "PK" });
    const batch = encodeFedBbsBatch([f]);
    expect(batch.bid.length).toBeLessThanOrEqual(12);
    const post = (bid: string) =>
      serve(hub)(
        new Request("https://hub.example/api/bbs/forward/inbound", {
          method: "POST",
          headers: { "content-type": "application/json", "x-ingest-secret": "test-ingest-secret" },
          body: JSON.stringify({
            message: { bid, type: "P", from: "OE8APR", to: "ACSFED", body: batch.body },
            origin: "rf-fbb:OE1PRT-1",
          }),
        }),
      );
    expect((await post("SQUAT1")).status).toBe(400); // a squatter's BID never claims the content
    const ok = (await (await post(batch.bid)).json()) as { stored: number };
    expect(ok.stored).toBe(1);
  });

  it("refuses a pull page larger than 4 MiB", async () => {
    const { a, hub } = await pair();
    const inner = serve(a);
    const huge = new Uint8Array(5 * 1024 * 1024);
    stubFetch({
      [A]: (req) =>
        new URL(req.url).pathname === "/federation/sync/cache"
          ? Promise.resolve(new Response(huge, { headers: { "content-type": "application/cbor" } }))
          : inner(req),
    });
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/too large/);
  });

  it("refuses a page with more frames than it asked for", async () => {
    const { a, hub } = await pair();
    const f = await frame(a, "cache", "a.example:cache:1", 1000, { code: "AC-1", title: "t", updatedAt: 1000 });
    const inner = serve(a);
    stubFetch({
      [A]: (req) =>
        new URL(req.url).pathname === "/federation/sync/cache"
          ? Promise.resolve(page(Array.from({ length: 501 }, () => f)))
          : inner(req),
    });
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/frames/);
  });
});

describe("relay spokes are isolated by their own keys", () => {
  const SECRET = "relaysecret";
  async function hubWithSpokes() {
    const hub = instanceEnv("hub.example", await newFedKey(), { FED_RELAY_SECRET: SECRET });
    const spokes: Record<string, { key: FedKey; env: Env }> = {};
    for (const name of ["s1.example", "s2.example"]) {
      const key = await newFedKey();
      spokes[name] = {
        key,
        env: instanceEnv(name, key, { FED_HUB_URL: "https://hub.example", FED_RELAY_SECRET: SECRET }),
      };
      await hub.DB.prepare(
        "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via, enabled) VALUES (?, ?, ?, ?, 'trusted', 'submitted', 0)",
      )
        .bind(`submit:${name}`, name, key.pub, JSON.stringify([{ x: key.pub }]))
        .run();
    }
    return { hub, spokes };
  }
  const enqueue = (hub: Env, target: string) =>
    serve(hub)(
      new Request(`https://hub.example/federation/relay/${target}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-relay-secret": SECRET, "x-real-ip": "203.0.113.5" },
        body: JSON.stringify({ kind: "feed", params: { feed: "caches" } }),
      }),
    );

  it("a spoke holding the shared secret cannot lease another spoke's queue", async () => {
    const { hub } = await hubWithSpokes();
    await enqueue(hub, "s2.example");
    const k = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const token = Buffer.from(
      await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("relay-spoke:s2.example")),
    ).toString("hex");
    const r = await serve(hub)(
      new Request("https://hub.example/federation/relay/lease?instance=s2.example", {
        headers: { "x-relay-secret": SECRET, "x-relay-token": token },
      }),
    );
    expect(r.status).toBe(401);
  });

  it("the spoke's own poll leases and answers its queue, and the requester's ticket reads the result", async () => {
    const { hub, spokes } = await hubWithSpokes();
    const enq = (await (await enqueue(hub, "s1.example")).json()) as { id: number; ticket: string };
    stubFetch({ "https://hub.example": serve(hub) });
    const { relayPoll } = await import("@aprscaching/gateway/relay");
    await relayPoll(spokes["s1.example"]!.env);
    const read = (ticket?: string) =>
      serve(hub)(
        new Request(`https://hub.example/federation/relay/result/${enq.id}`, {
          headers: { "x-relay-secret": SECRET, ...(ticket ? { "x-relay-ticket": ticket } : {}) },
        }),
      );
    expect((await read()).status).toBe(403);
    const res = (await (await read(enq.ticket)).json()) as { status: string };
    expect(res.status).toBe("answered");
  });

  it("a lease that is never answered returns to the queue", async () => {
    const { hub } = await hubWithSpokes();
    await enqueue(hub, "s1.example");
    await hub.DB.prepare("UPDATE fed_relay_queue SET status = 'leased', leased_at = ?")
      .bind(nowS() - 3600)
      .run();
    const { expireRelayLeases } = await import("@aprscaching/gateway/relay");
    await expireRelayLeases(hub);
    const r = await hub.DB.prepare("SELECT status FROM fed_relay_queue").first<{ status: string }>();
    expect(r?.status).toBe("queued");
  });

  it("caps how many queries one requester can queue", async () => {
    const { hub } = await hubWithSpokes();
    let capped = 0;
    for (let i = 0; i < 120; i++) if ((await enqueue(hub, "s1.example")).status === 429) capped++;
    expect(capped).toBeGreaterThan(0);
  });
});

export type { Serve };
