// SPDX-License-Identifier: AGPL-3.0-or-later
// Federation data correctness over real instances: what stays home stays home, a page of records
// sharing one timestamp never stalls a feed, one malformed record never blocks the ones around it,
// and bulletins mirror end to end.
import { describe, it, expect, afterEach, vi } from "vitest";
import { encodeFedSyncPage, encodeFedBbsBatch } from "@aprscaching/shared";
import { syncAllPeers, applyFedFrames, applyFedBbsBulletin } from "@aprscaching/gateway/federation_sync";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import {
  newFedKey,
  instanceEnv,
  addCache,
  serve,
  stubFetch,
  servedFrames,
  peerRow,
  remoteCacheCount,
  type Serve,
} from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const A = "https://a.example";

async function pair() {
  const key = await newFedKey();
  const a = instanceEnv("a.example", key);
  const hub = instanceEnv("hub.example", await newFedKey());
  await hub.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES (?, 'a.example', ?, 'trusted', 'manual')",
  )
    .bind(A, key.pub)
    .run();
  return { key, a, hub };
}

describe("what stays home", () => {
  it("never federates a find on a local-only cache, on either feed surface", async () => {
    const a = instanceEnv("a.example", await newFedKey());
    const id = await addCache(a);
    await a.DB.prepare("UPDATE caches SET fed_scope = 'local-only' WHERE id = ?").bind(id).run();
    await a.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type) VALUES (?, 'OE8LOG', 1000, 'found')",
    )
      .bind(id)
      .run();
    expect(await servedFrames(a, "find")).toHaveLength(0);
    const json = (await (await serve(a)(new Request("https://a.example/federation/finds?since=0"))).json()) as {
      items: unknown[];
    };
    expect(json.items).toHaveLength(0);
  });
});

describe("paging", () => {
  it("propagates 1200 caches archived in the same second", async () => {
    const { a, hub } = await pair();
    for (let i = 0; i < 1200; i++) await addCache(a, 5000);
    stubFetch({ [A]: serve(a) });
    const r = await syncAllPeers(hub);
    expect(r.errors).toEqual([]);
    expect(await remoteCacheCount(hub, "a.example")).toBe(1200);
  });
});

describe("one bad record never blocks the rest", () => {
  async function keyFrame(env: Env, n: number, body: Record<string, unknown>) {
    return (await signFedRecord(env, {
      kind: "key",
      gid: `a.example:key:${n}`,
      origin: "a.example",
      v: n,
      at: 1000,
      signer: "a.example",
      body,
    }))!;
  }
  const good = (n: number) => ({ callsign: `OE8K${n}`, publicKey: `PK${n}`, createdAt: 1000 });

  it("applies the frames around a malformed one on a pulled page and moves the cursor past it", async () => {
    const { a, hub } = await pair();
    const frames = [
      await keyFrame(a, 1, good(1)),
      await keyFrame(a, 2, { publicKey: "PK2" }),
      await keyFrame(a, 3, good(3)),
    ];
    const inner = serve(a);
    const route: Serve = (req) =>
      new URL(req.url).pathname === "/federation/sync/key"
        ? Promise.resolve(
            new Response(encodeFedSyncPage("a.example", 3, true, frames) as BodyInit, {
              headers: { "content-type": "application/cbor" },
            }),
          )
        : inner(req);
    stubFetch({ [A]: route });
    await syncAllPeers(hub);
    const n = await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_keys").first<{ n: number }>();
    expect(n?.n).toBe(2);
    expect((await peerRow(hub, A))?.keys_cursor).toBe(3);
  });

  it("applies the frames around a malformed one in an FBB bulletin", async () => {
    const { a, hub } = await pair();
    const frames = [
      await keyFrame(a, 1, good(1)),
      await keyFrame(a, 2, { publicKey: "PK2" }),
      await keyFrame(a, 3, good(3)),
    ];
    const r = await applyFedBbsBulletin(hub, encodeFedBbsBatch(frames).body);
    expect(r.applied).toBe(2);
    expect(r.rejected).toBe(1);
  });
});

describe("bulletins", () => {
  it("mirror from a peer end to end", async () => {
    const { a, hub } = await pair();
    await a.DB.prepare(
      "INSERT INTO bbs_messages (bid, type, from_call, to_call, subject, body, posted_at, origin) VALUES ('7_a.example', 'B', 'OE8APR', 'ALL', 'Net tonight', 'QRV 20:00', ?, 'local')",
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    stubFetch({ [A]: serve(a) });
    await syncAllPeers(hub);
    const row = await hub.DB.prepare("SELECT bid, subject, origin FROM bbs_messages WHERE origin = 'a.example'").first<{
      bid: string;
      subject: string;
    }>();
    expect(row).toMatchObject({ bid: "7_a.example", subject: "Net tonight" });
  });

  it("still accepts a bulletin frame under its old <id>_<instance> gid", async () => {
    const { a, hub } = await pair();
    const frame = await signFedRecord(a, {
      kind: "bulletin",
      gid: "9_a.example",
      origin: "a.example",
      v: 1000,
      at: 1000,
      signer: "a.example",
      body: { fromCall: "OE8APR", toCall: "ALL", subject: "old", body: "legacy gid", postedAt: 1000 },
    });
    expect((await applyFedFrames(hub, [frame!])).applied).toBe(1);
  });
});

describe("same-second updates", () => {
  it("mirror a cache archived in the same second it was first mirrored", async () => {
    const { a, hub } = await pair();
    const id = await addCache(a, 7000);
    stubFetch({ [A]: serve(a) });
    await syncAllPeers(hub);
    await a.DB.prepare("UPDATE caches SET status = 'archived' WHERE id = ?").bind(id).run(); // updated_at unchanged
    await syncAllPeers(hub);
    const row = await hub.DB.prepare("SELECT status FROM remote_caches WHERE global_id = ?")
      .bind(`a.example:cache:${id}`)
      .first<{ status: string }>();
    expect(row?.status).toBe("archived");
  });
});
