// SPDX-License-Identifier: AGPL-3.0-or-later
// Ownership follows the account, never the call string: a cache (its stages, media gallery, edits) and a
// saved view belong to whichever account holds the owner call's licence (base call). The holder acts as
// owner while operating any call it holds; another account never does, whatever call string it presents;
// and a machine acts for an owner only over the ingest plane, naming that exact owner call.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, type Res } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };

interface World {
  env: Env;
  ownerOther: Res; // the same account, switched to its second held call OE9SEC
  stranger: Res; // another account
  cacheId: number;
}

async function world(): Promise<World> {
  const media = { put: async () => {}, get: async () => null, delete: async () => {} };
  const env = authEnv({ MEDIA: media });
  const owner = await emailSignup(env, "owner@example.test", "OE8OWN");
  expect(owner.status).toBe(200);
  const created = await call(
    env,
    "POST",
    "/api/caches",
    { title: "oak", type: "traditional", lat: 47, lon: 15 },
    { cookie: owner.cookie },
  );
  expect(created.status).toBe(201);
  // the owner holds a second call and operates it
  const sw = await call(env, "POST", "/auth/callsign", { callsign: "OE9SEC" }, { cookie: owner.cookie });
  expect(sw.status).toBe(200);
  const stranger = await emailSignup(env, "dl1oth@example.test", "DL1OTH");
  return { env, ownerOther: sw, stranger, cacheId: created.data.cache.id as number };
}

const STAGES = { stages: [{ stageNo: 0, unlock: "open", lat: 47, lon: 15 }] };

async function upload(env: Env, cacheId: number, headers: Record<string, string>) {
  return serve(env)(
    new Request(`https://gw.test/api/caches/${cacheId}/media?title=x`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-real-ip": "192.0.2.10", ...headers },
      body: new Uint8Array([1, 2, 3]),
    }),
  );
}

describe("cache ownership is account-bound", () => {
  it("the holder sets stages while operating another held call; a stranger cannot", async () => {
    const w = await world();
    const mine = await call(w.env, "POST", `/api/caches/${w.cacheId}/stages`, STAGES, { cookie: w.ownerOther.cookie });
    expect(mine.status).toBe(200);
    const theirs = await call(
      w.env,
      "POST",
      `/api/caches/${w.cacheId}/stages`,
      { ...STAGES, ownerCall: "OE8OWN" },
      { cookie: w.stranger.cookie },
    );
    expect(theirs.status).toBe(403);
  });

  it("stages over the ingest plane need the exact owner call", async () => {
    const w = await world();
    const ok = await call(w.env, "POST", `/api/caches/${w.cacheId}/stages`, { ...STAGES, ownerCall: "OE8OWN" }, INGEST);
    expect(ok.status).toBe(200);
    const other = await call(
      w.env,
      "POST",
      `/api/caches/${w.cacheId}/stages`,
      { ...STAGES, ownerCall: "DL1OTH" },
      INGEST,
    );
    expect(other.status).toBe(403);
    const bare = await call(w.env, "POST", `/api/caches/${w.cacheId}/stages`, { ...STAGES, ownerCall: "OE8OWN" });
    expect(bare.status).toBe(403);
  });

  it("the holder adds and deletes gallery media from any held call; a stranger naming the owner cannot", async () => {
    const w = await world();
    const cookie = (r: Res) => ({ cookie: r.cookie });
    const add = await upload(w.env, w.cacheId, cookie(w.ownerOther));
    expect(add.status).toBe(201);
    const id = ((await add.json()) as { item: { id: number } }).item.id;
    expect((await upload(w.env, w.cacheId, { ...cookie(w.stranger), "x-owner-call": "OE8OWN" })).status).toBe(403);
    const del = (h: Record<string, string>) =>
      call(w.env, "DELETE", `/api/caches/${w.cacheId}/media/${id}`, undefined, h);
    expect((await del({ ...cookie(w.stranger), "x-owner-call": "OE8OWN" })).status).toBe(403);
    expect((await del(cookie(w.ownerOther))).status).toBe(200);
  });

  it("gallery media over the ingest plane need the exact owner call", async () => {
    const w = await world();
    expect((await upload(w.env, w.cacheId, { ...INGEST, "x-owner-call": "OE8OWN" })).status).toBe(201);
    expect((await upload(w.env, w.cacheId, { ...INGEST, "x-owner-call": "DL1OTH" })).status).toBe(403);
    expect((await upload(w.env, w.cacheId, { "x-owner-call": "OE8OWN" })).status).toBe(403);
  });

  it("the holder edits the cache from any held call; a stranger cannot", async () => {
    const w = await world();
    const edit = (h: Record<string, string>, body: Record<string, unknown> = {}) =>
      call(w.env, "PATCH", `/api/caches/${w.cacheId}`, { title: "renamed", ...body }, h);
    expect((await edit({ cookie: w.ownerOther.cookie })).status).toBe(200);
    expect((await edit({ cookie: w.stranger.cookie }, { ownerCall: "OE8OWN" })).status).toBe(403);
    expect((await edit(INGEST, { ownerCall: "OE8OWN" })).status).toBe(200);
    expect((await edit(INGEST, { ownerCall: "DL1OTH" })).status).toBe(403);
  });
});

describe("saved views are account-bound", () => {
  it("a view saved under one held call is listed, read and deleted from another; a stranger cannot", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "v@example.test", "OE8VUE");
    const v = await call(env, "POST", "/api/views", { state: { z: 3 }, public: false }, { cookie: s.cookie });
    expect(v.status).toBe(201);
    const slug = v.data.slug as string;
    const sw = await call(env, "POST", "/auth/callsign", { callsign: "OE9VUE" }, { cookie: s.cookie });
    expect(sw.status).toBe(200);
    const stranger = await emailSignup(env, "x@example.test", "DL1XYZ");

    expect((await call(env, "GET", `/v/${slug}`, undefined, { cookie: stranger.cookie })).status).toBe(403);
    expect((await call(env, "DELETE", `/api/views/${slug}`, undefined, { cookie: stranger.cookie })).status).toBe(403);
    expect((await call(env, "GET", `/v/${slug}`, undefined, { cookie: sw.cookie })).status).toBe(200);
    const list = await call(env, "GET", "/api/views", undefined, { cookie: sw.cookie });
    expect(list.data.views.map((x: { slug: string }) => x.slug)).toEqual([slug]);
    expect((await call(env, "GET", "/api/views", undefined, { cookie: stranger.cookie })).data.views).toEqual([]);
    expect((await call(env, "DELETE", `/api/views/${slug}`, undefined, { cookie: sw.cookie })).status).toBe(200);
  });
});
