// SPDX-License-Identifier: AGPL-3.0-or-later
// A sysop's removal of a cache reaches the peers as a tombstone that covers the cache up to that removal: the
// peers drop it, a replay of an older copy stays dropped, and a restore (a later version) reaches them again.
// Every other tombstone, an erasure's, suppresses the record for good.
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers, applyFedFrames } from "@aprscaching/gateway/federation_sync";
import { call } from "./helpers/authflow.js";
import { addCache, gid, instanceEnv, newFedKey, serve, servedFrames, stubFetch } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const OP = { "x-operator-secret": "test-operator-secret" };
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
  const id = await addCache(a, Math.floor(Date.now() / 1000) - 60);
  stubFetch({ [A]: serve(a) });
  await syncAllPeers(hub);
  return { a, hub, id };
}

const mirrored = async (hub: Env) =>
  (await hub.DB.prepare("SELECT status FROM remote_caches WHERE global_id LIKE 'a.example:cache:%'").first<{
    status: string;
  }>()) ?? null;

describe("a restored cache reaches the peers again", () => {
  it("the removal drops it, an older copy stays dropped, the restore mirrors it disabled", async () => {
    const { a, hub, id } = await pair();
    expect(await mirrored(hub)).toMatchObject({ status: "active" });
    const before = await servedFrames(a); // the copy a replay would carry

    const rm = await call(a, "POST", "/api/admin/moderation/remove", { kind: "cache", id, reason: "takedown" }, OP);
    expect(rm.status).toBe(200);
    const t = await a.DB.prepare("SELECT up_to FROM tombstones WHERE target_id = ?")
      .bind(await gid(a, "cache", id))
      .first<{ up_to: number }>();
    // the removal covers the cache's place in the caches sequence, where the removal itself put it
    const rev = await a.DB.prepare("SELECT fed_rev FROM caches WHERE id = ?").bind(id).first<{ fed_rev: number }>();
    expect(t?.up_to).toBe(rev?.fed_rev);
    await syncAllPeers(hub);
    expect(await mirrored(hub)).toBeNull();
    expect((await applyFedFrames(hub, before)).applied).toBe(0);

    const rs = await call(
      a,
      "POST",
      "/api/admin/moderation/restore",
      { kind: "cache", id, reason: "appeal upheld" },
      OP,
    );
    expect(rs.status).toBe(200);
    await syncAllPeers(hub);
    expect(await mirrored(hub)).toMatchObject({ status: "disabled" });
    expect((await applyFedFrames(hub, before)).applied).toBe(0); // still older than the removal
  });

  it("a restore that arrives before the removal's tombstone stays", async () => {
    const { a, hub, id } = await pair();
    await call(a, "POST", "/api/admin/moderation/remove", { kind: "cache", id, reason: "takedown" }, OP);
    await call(a, "POST", "/api/admin/moderation/restore", { kind: "cache", id, reason: "appeal upheld" }, OP);
    expect((await applyFedFrames(hub, await servedFrames(a))).applied).toBe(1); // the restored cache first
    await syncAllPeers(hub); // then the tombstone feed
    expect(await mirrored(hub)).toMatchObject({ status: "disabled" });
  });

  it("an erasure's tombstone suppresses every later version too", async () => {
    const { a, hub, id } = await pair();
    await a.DB.prepare(
      "INSERT INTO tombstones (id, kind, target_id, origin, ts) VALUES ('t1', 'cache', ?, 'a.example', ?)",
    )
      .bind(await gid(a, "cache", id), Math.floor(Date.now() / 1000))
      .run();
    await syncAllPeers(hub);
    expect(await mirrored(hub)).toBeNull();
    await a.DB.prepare("UPDATE caches SET title = 'edited', updated_at = updated_at + 10 WHERE id = ?").bind(id).run();
    await syncAllPeers(hub);
    expect((await applyFedFrames(hub, await servedFrames(a))).applied).toBe(0);
    expect(await mirrored(hub)).toBeNull();
  });
});
