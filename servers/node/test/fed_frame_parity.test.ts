// SPDX-License-Identifier: AGPL-3.0-or-later
// Every carrier admits a signed frame through the same checks: a frame refused on one path
// (pulled from a peer, received over a store-and-forward carrier, or pushed to a hub) is refused
// on the others too. Each case below is fed through all three and must come out the same.
import { describe, it, expect, afterEach, vi } from "vitest";
import { newFedKey, instanceEnv, addCache, serve, stubFetch, servedFrames, type FedKey } from "./helpers/fedpeer.js";
import { applyFedFrames, syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import { encodeFedSyncPage } from "@aprscaching/gateway/fedsync";
import { decodeFedFrame, type FedRecord } from "@aprscaching/shared";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "submit-secret";
const S = "s.example";
const S_URL = `https://${S}`;
const nowS = () => Math.floor(Date.now() / 1000);

afterEach(() => vi.unstubAllGlobals());

type Path = "pull" | "carrier" | "submit";

/** A hub that already knows the spoke under its key, on every path. */
async function knownHub(key: FedKey): Promise<Env> {
  const hub = instanceEnv("hub.example", await newFedKey(), { FED_SUBMIT_SECRET: SECRET });
  await hub.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, trust, added_via, enabled) VALUES (?, ?, ?, 'trusted', 'manual', 1)",
  )
    .bind(S_URL, S, key.pub)
    .run();
  return hub;
}

/** Deliver frames to the hub over one path; returns how many were applied. */
async function deliver(path: Path, hub: Env, spoke: Env, frames: Uint8Array[], type = "cache"): Promise<number> {
  if (path === "carrier") return (await applyFedFrames(hub, frames)).applied;
  const page = encodeFedSyncPage(S, 0, true, frames);
  if (path === "submit") {
    const res = await serve(hub)(
      new Request("https://hub.example/federation/submit", {
        method: "POST",
        headers: { "content-type": "application/cbor", "x-fed-secret": SECRET },
        body: page as BodyInit,
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { applied: number }).applied;
  }
  // pull: the spoke's descriptor is genuine; its sync page for `type` carries exactly these frames
  await hub.DB.prepare(
    "UPDATE fed_peers SET caches_cursor = 0, caches_cursor_id = NULL, tombstones_cursor = 0, bulletins_cursor = 0 WHERE url = ?",
  )
    .bind(S_URL)
    .run();
  const genuine = serve(spoke);
  stubFetch({
    [S_URL]: async (req) =>
      new URL(req.url).pathname === `/federation/sync/${type}`
        ? new Response(page as BodyInit, { headers: { "content-type": "application/cbor" } })
        : genuine(req),
  });
  const r = await syncAllPeers(hub);
  expect(r.errors).toEqual([]);
  return r.caches + r.finds + r.keys + r.tombstones + r.moves + r.bulletins;
}

async function spokeFixture() {
  const key = await newFedKey();
  const spoke = instanceEnv(S, key);
  await addCache(spoke, 1000);
  const [frame] = await servedFrames(spoke);
  return { key, spoke, frame: frame!, record: decodeFedFrame(frame!).record };
}

const resign = async (spoke: Env, rec: FedRecord, patch: Partial<FedRecord>) =>
  (await signFedRecord(spoke, { ...rec, ...patch }))!;

const remoteCaches = async (hub: Env) =>
  (await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches").first<{ n: number }>())?.n ?? 0;

describe.each<Path>(["pull", "carrier", "submit"])("frame admission via %s", (path) => {
  it("applies a genuine frame once, and refuses its replay", async () => {
    const { key, spoke, frame } = await spokeFixture();
    const hub = await knownHub(key);
    expect(await deliver(path, hub, spoke, [frame])).toBe(1);
    expect(await deliver(path, hub, spoke, [frame])).toBe(0);
    expect(await remoteCaches(hub)).toBe(1);
  });

  it("refuses an older version after a newer one applied", async () => {
    const { key, spoke, record } = await spokeFixture();
    const hub = await knownHub(key);
    expect(await deliver(path, hub, spoke, [await resign(spoke, record, { v: record.v + 5 })])).toBe(1);
    expect(await deliver(path, hub, spoke, [await resign(spoke, record, { v: record.v + 1 })])).toBe(0);
  });

  it("refuses a record its origin has tombstoned", async () => {
    const { key, spoke, frame, record } = await spokeFixture();
    const hub = await knownHub(key);
    await hub.DB.prepare(
      "INSERT INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at) VALUES (?, ?, 'cache', ?, ?)",
    )
      .bind(record.gid, S, nowS(), nowS())
      .run();
    expect(await deliver(path, hub, spoke, [frame])).toBe(0);
    expect(await remoteCaches(hub)).toBe(0);
  });

  it("refuses a gid outside the origin's namespace", async () => {
    const { key, spoke, record } = await spokeFixture();
    const hub = await knownHub(key);
    const f = await resign(spoke, record, { gid: record.gid.replace(`${S}:`, "victim.example:") });
    expect(await deliver(path, hub, spoke, [f])).toBe(0);
  });

  it("refuses a record signed as another instance", async () => {
    const { key, spoke, record } = await spokeFixture();
    const hub = await knownHub(key);
    expect(await deliver(path, hub, spoke, [await resign(spoke, record, { signer: "victim.example" })])).toBe(0);
  });

  it("refuses a record signed in the future", async () => {
    const { key, spoke, record } = await spokeFixture();
    const hub = await knownHub(key);
    expect(await deliver(path, hub, spoke, [await resign(spoke, record, { at: nowS() + 3600 })])).toBe(0);
  });

  it("refuses a frame under a key the origin does not hold", async () => {
    const { key, spoke, record } = await spokeFixture();
    const hub = await knownHub(key);
    const forger = instanceEnv(S, await newFedKey());
    const f = await resign(forger, record, {});
    if (path === "submit") {
      // a submission is bound to one key: a key the hub does not hold for the spoke is refused whole
      const res = await serve(hub)(
        new Request("https://hub.example/federation/submit", {
          method: "POST",
          headers: { "content-type": "application/cbor", "x-fed-secret": SECRET },
          body: encodeFedSyncPage(S, 0, true, [f]) as BodyInit,
        }),
      );
      expect(res.status).toBe(403);
    } else expect(await deliver(path, hub, spoke, [f])).toBe(0);
    expect(await remoteCaches(hub)).toBe(0);
  });
});

describe("submit carries mirror records only", () => {
  it("refuses a peer-announce frame that a store-and-forward carrier would act on", async () => {
    const { key, spoke } = await spokeFixture();
    const hub = await knownHub(key);
    const announce = (await signFedRecord(spoke, {
      kind: "peer",
      gid: `${S}:peer:1`,
      origin: S,
      v: nowS(),
      at: nowS(),
      signer: S,
      body: { addresses: [{ transport: "https", address: "https://new.s.example", priority: 10 }] },
    }))!;
    const res = await serve(hub)(
      new Request("https://hub.example/federation/submit", {
        method: "POST",
        headers: { "content-type": "application/cbor", "x-fed-secret": SECRET },
        body: encodeFedSyncPage(S, 0, true, [announce]) as BodyInit,
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, applied: 0, rejected: 1 });
    expect((await applyFedFrames(hub, [announce])).applied).toBe(1);
  });
});
