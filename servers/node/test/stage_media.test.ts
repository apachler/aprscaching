// SPDX-License-Identifier: AGPL-3.0-or-later
// A stage's audio clue is stored only for a stage that exists, gets a fresh key on every upload so a replaced
// clip never answers from a cache, and stays with its stage when the owner saves the stage list again. Every
// stored object belongs to exactly one stage row, so the media quota counts all of it.
import { describe, it, expect } from "vitest";
import { authEnv, call, hiderSignup } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

type Stage = { stageNo: number; prevStageNo?: number; unlock: string; lat?: number; lon?: number; clue?: string };

async function world() {
  const objects = new Map<string, Uint8Array>();
  const env = authEnv({
    MEDIA: {
      put: async (k: string, b: Uint8Array) => void objects.set(k, b),
      get: async (k: string) => (objects.has(k) ? { bytes: objects.get(k)!, contentType: "audio/mpeg" } : null),
      delete: async (k: string) => void objects.delete(k),
    },
  }) as Env;
  const owner = await hiderSignup(env, "clips@example.test", "OE8CLP");
  const id = (
    await call(
      env,
      "POST",
      "/api/caches",
      { title: "bridges", type: "multi", lat: 47, lon: 15 },
      { cookie: owner.cookie },
    )
  ).data.cache.id as number;
  const save = async (stages: Stage[]) =>
    (await call(env, "POST", `/api/caches/${id}/stages`, { stages }, { cookie: owner.cookie })).status;
  const upload = async (n: number, contentType = "audio/mpeg", size = 1000) => {
    const res = await serve(env)(
      new Request(`https://gw.test/api/caches/${id}/stages/${n}/media`, {
        method: "PUT",
        headers: { "content-type": contentType, cookie: owner.cookie!, "x-real-ip": "192.0.2.20" },
        body: new Uint8Array(size),
      }),
    );
    return { status: res.status, body: (await res.json()) as { mediaKey?: string; error?: string } };
  };
  const rows = async () =>
    (
      await env.DB.prepare(
        "SELECT stage_no, media_key, media_bytes FROM cache_stages WHERE cache_id=? ORDER BY stage_no",
      )
        .bind(id)
        .all<{ stage_no: number; media_key: string | null; media_bytes: number | null }>()
    ).results;
  return { env, objects, id, save, upload, rows };
}

const three: Stage[] = [
  { stageNo: 0, unlock: "open", lat: 47, lon: 15, clue: "start" },
  { stageNo: 1, unlock: "audio", lat: 47.01, lon: 15.01, clue: "decode the tones" },
  { stageNo: 2, unlock: "audio", lat: 47.02, lon: 15.02, clue: "listen again" },
];

describe("a stage's audio clue", () => {
  it("is refused for a stage that does not exist, and nothing is stored", async () => {
    const w = await world();
    await w.save(three);
    const res = await w.upload(7);
    expect(res.status).toBe(404);
    expect(w.objects.size).toBe(0);
  });

  it("gets a new key on each upload and frees the clip it replaces", async () => {
    const w = await world();
    await w.save(three);
    const first = await w.upload(1, "audio/mpeg");
    const second = await w.upload(1, "audio/ogg");
    const third = await w.upload(1, "audio/ogg");
    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(new Set([first.body.mediaKey, second.body.mediaKey, third.body.mediaKey]).size).toBe(3);
    expect([...w.objects.keys()]).toEqual([third.body.mediaKey]);
    expect((await w.rows())[1]).toMatchObject({ media_key: third.body.mediaKey, media_bytes: 1000 });
  });

  it("survives saving the stages again, with its bytes still counted", async () => {
    const w = await world();
    await w.save(three);
    const up = await w.upload(1, "audio/mpeg", 2500);
    expect(await w.save(three.map((s) => (s.stageNo === 1 ? { ...s, clue: "decode the tones twice" } : s)))).toBe(200);
    expect((await w.rows())[1]).toMatchObject({ media_key: up.body.mediaKey, media_bytes: 2500 });
    expect(w.objects.has(up.body.mediaKey!)).toBe(true);
    const view = (await call(w.env, "GET", `/api/caches/${w.id}/stages`)).data.stages as { mediaUrl: string | null }[];
    expect(view[1]?.mediaUrl).toBe(`/api/media/${up.body.mediaKey}`);
  });

  it("is freed when its stage is removed or stops being an audio stage", async () => {
    const w = await world();
    await w.save(three);
    const one = await w.upload(1);
    const two = await w.upload(2);
    expect(w.objects.size).toBe(2);
    expect(await w.save([three[0]!, { ...three[1]!, unlock: "geo" }])).toBe(200);
    expect(w.objects.size).toBe(0);
    expect(w.objects.has(one.body.mediaKey!) || w.objects.has(two.body.mediaKey!)).toBe(false);
    expect((await w.rows()).map((r) => r.media_key)).toEqual([null, null]);
  });

  it("moves with its stage when a stage before it is removed", async () => {
    const w = await world();
    await w.save(three);
    const one = await w.upload(1);
    const two = await w.upload(2);
    // stage 1 removed: the old stage 2 is now stage 1, and says where it came from
    expect(await w.save([three[0]!, { ...three[2]!, stageNo: 1, prevStageNo: 2 }])).toBe(200);
    expect((await w.rows()).map((r) => r.media_key)).toEqual([null, two.body.mediaKey]);
    expect([...w.objects.keys()]).toEqual([two.body.mediaKey]);
    expect(w.objects.has(one.body.mediaKey!)).toBe(false);
    const view = (await call(w.env, "GET", `/api/caches/${w.id}/stages`)).data.stages as { mediaUrl: string | null }[];
    expect(view[1]?.mediaUrl).toBe(`/api/media/${two.body.mediaKey}`);
    // the clip is served for the stage that holds it now, under the key it was stored with
    const res = await serve(w.env)(new Request(`https://gw.test/api/media/${two.body.mediaKey}`));
    expect(res.status).toBe(200);
  });

  it("goes to one stage only when two name the same previous number", async () => {
    const w = await world();
    await w.save(three);
    const two = await w.upload(2);
    expect(await w.save([three[0]!, { ...three[1]!, prevStageNo: 2 }, { ...three[2]!, prevStageNo: 2 }])).toBe(200);
    expect((await w.rows()).map((r) => r.media_key)).toEqual([null, two.body.mediaKey, null]);
  });
});
