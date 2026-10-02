// SPDX-License-Identifier: AGPL-3.0-or-later
// A locked stage keeps its clue and clip until the finder unlocks it, except an audio stage, whose clip is the
// puzzle that opens it. The start is always open.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

async function world() {
  const objects = new Map<string, Uint8Array>();
  const env = authEnv({
    MEDIA: {
      put: async (k: string, b: Uint8Array) => void objects.set(k, b),
      get: async (k: string) => (objects.has(k) ? { bytes: objects.get(k)!, contentType: "audio/mpeg" } : null),
      delete: async (k: string) => void objects.delete(k),
    },
  }) as Env;
  const owner = await emailSignup(env, "owner@example.test", "OE8OWN");
  const finder = await emailSignup(env, "finder@example.test", "DL1FND");
  const id = (
    await call(
      env,
      "POST",
      "/api/caches",
      { title: "bridges", type: "multi", lat: 47, lon: 15 },
      { cookie: owner.cookie },
    )
  ).data.cache.id as number;
  await call(
    env,
    "POST",
    `/api/caches/${id}/stages`,
    {
      stages: [
        { stageNo: 0, unlock: "open", lat: 47, lon: 15, clue: "count the rivets" },
        { stageNo: 1, unlock: "open", lat: 47.01, lon: 15.01, clue: "behind the oak" },
        { stageNo: 2, unlock: "audio", lat: 47.02, lon: 15.02, clue: "decode the tones" },
      ],
    },
    { cookie: owner.cookie },
  );
  for (const n of [1, 2])
    await env.MEDIA!.put(`cache/${id}/stage/${n}/clue.mp3`, new Uint8Array([1, 2, 3]), "audio/mpeg");
  await env.DB.prepare(
    "UPDATE cache_stages SET media_key = 'cache/' || cache_id || '/stage/' || stage_no || '/clue.mp3' WHERE cache_id = ? AND stage_no > 0",
  )
    .bind(id)
    .run();
  const stages = async (cookie: string) =>
    (await call(env, "GET", `/api/caches/${id}/stages`, undefined, { cookie })).data.stages as {
      clue: string | null;
      mediaUrl: string | null;
    }[];
  const clip = async (n: number, cookie: string) =>
    (await call(env, "GET", `/api/media/cache/${id}/stage/${n}/clue.mp3`, undefined, { cookie })).status;
  return { env, owner, finder, id, stages, clip };
}

describe("a locked stage's clue", () => {
  it("stays hidden until unlocked, except an audio stage's, and the start's", async () => {
    const w = await world();
    const locked = await w.stages(w.finder.cookie);
    expect(locked.map((s) => s.clue)).toEqual(["count the rivets", null, "decode the tones"]);
    expect(locked[1]!.mediaUrl).toBeNull();
    expect(locked[2]!.mediaUrl).not.toBeNull();
    expect(await w.clip(1, w.finder.cookie)).toBe(404);
    expect(await w.clip(2, w.finder.cookie)).toBe(200);

    await call(w.env, "POST", `/api/caches/${w.id}/stages/1/unlock`, {}, { cookie: w.finder.cookie });
    expect((await w.stages(w.finder.cookie))[1]!.clue).toBe("behind the oak");
    expect(await w.clip(1, w.finder.cookie)).toBe(200);
  });

  it("is the owner's to see on every stage", async () => {
    const w = await world();
    expect((await w.stages(w.owner.cookie)).map((s) => s.clue)).toEqual([
      "count the rivets",
      "behind the oak",
      "decode the tones",
    ]);
    expect(await w.clip(1, w.owner.cookie)).toBe(200);
  });
});
