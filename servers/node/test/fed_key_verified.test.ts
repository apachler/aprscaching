// SPDX-License-Identifier: AGPL-3.0-or-later
// A device key's `verified` flag is its callsign's verification at the time the key feed serves it. When the
// call is verified (or loses it) after the key went out, the key is served again under the same global id,
// so peers that check an account move's proof key against it see the call's current state.
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { newFedKey, instanceEnv, serve, stubFetch } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const A = "https://a.example";

async function pair() {
  const key = await newFedKey();
  const a = instanceEnv("a.example", key);
  const hub = instanceEnv("hub.example", await newFedKey());
  await hub.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, 'a.example', ?, ?, 'trusted', 'manual')",
  )
    .bind(A, key.pub, JSON.stringify([{ x: key.pub }]))
    .run();
  stubFetch({ [A]: serve(a) });
  return { a, hub };
}

const addKey = (env: Env, callsign: string, publicKey: string) =>
  env.DB.prepare("INSERT INTO callsign_keys (callsign, public_key, created_at) VALUES (?, ?, 1000)")
    .bind(callsign, publicKey)
    .run();

const held = async (hub: Env) =>
  (
    await hub.DB.prepare("SELECT global_id, callsign, verified FROM remote_keys ORDER BY callsign").all<{
      global_id: string;
      callsign: string;
      verified: number;
    }>()
  ).results;

describe("a key's verified flag follows its call", () => {
  it("re-serves the call's keys when the call is verified and when it loses it", async () => {
    const { a, hub } = await pair();
    await addKey(a, "OE8K", "PK1");
    await addKey(a, "OE8K-7", "PK2");
    await addKey(a, "OE8OTHER", "PK3");
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    const before = await held(hub);
    expect(before.map((r) => r.verified)).toEqual([0, 0, 0]);

    await a.DB.prepare(
      "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8K', 'sysop', 'verified', 2000)",
    ).run();
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    const after = await held(hub);
    // one row per key, under the global id it first went out with; both SSIDs of the call follow it
    expect(after.map((r) => r.global_id)).toEqual(before.map((r) => r.global_id));
    expect(after.map((r) => [r.callsign, r.verified])).toEqual([
      ["OE8K", 1],
      ["OE8K-7", 1],
      ["OE8OTHER", 0],
    ]);

    await a.DB.prepare("UPDATE callsign_verifications SET status = 'failed' WHERE callsign = 'OE8K'").run();
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect((await held(hub)).map((r) => r.verified)).toEqual([0, 0, 0]);
  });

  it("a key page boundary inside one call's keys loses none of them", async () => {
    const { a, hub } = await pair();
    for (let i = 0; i < 5; i++) await addKey(a, `OE8K-${i + 1}`, `PK${i}`);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    await a.DB.prepare(
      "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8K', 'sysop', 'verified', 2000)",
    ).run();
    // every key takes a place of its own in the feed, so a page that ends between two of them resumes at the next
    const revs = (await a.DB.prepare("SELECT fed_rev FROM callsign_keys").all<{ fed_rev: number }>()).results;
    expect(new Set(revs.map((r) => r.fed_rev)).size).toBe(5);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect((await held(hub)).every((r) => r.verified === 1)).toBe(true);
  });
});
