// SPDX-License-Identifier: AGPL-3.0-or-later
// Multi-stage caches offline: an NFC stage with a strong enough tag code is sealed under it when the owner
// saves the stages, and an offline pack carries only that sealed blob (plus the public start); a weak code
// or a geo stage stays online-only, and the owner is told why.
import { describe, it, expect } from "vitest";
import { openSealedStage, type PackResponse } from "@aprscaching/shared";
import { instanceEnv, serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const OWNER = { "x-ingest-secret": "test-ingest-secret", "x-owner-call": "OE8OWN" };
const SERIAL = "04:A2:5F:1B:3C:80:90";

async function setup() {
  const objects = new Map<string, Uint8Array>();
  const env = instanceEnv("stages.example", null, {
    MEDIA: {
      put: async (k: string, b: Uint8Array) => void objects.set(k, b),
      get: async (k: string) => (objects.has(k) ? { bytes: objects.get(k)!, contentType: "audio/mpeg" } : null),
      delete: async (k: string) => void objects.delete(k),
    },
  }) as unknown as Env;
  const r = await env.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, status, created_at, updated_at) VALUES ('AC-MS', 'OE8OWN', 'Multi', 'multi', 47.1, 15.1, 'active', 1, 1)",
  ).run();
  return { env, id: Number(r.meta.last_row_id) };
}
const post = (env: Env, path: string, body: unknown) =>
  serve(env)(
    new Request(`https://stages.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify(body),
    }),
  );
const STAGES = [
  { stageNo: 0, unlock: "open", lat: 47.1, lon: 15.1, clue: "start at the bench" },
  { stageNo: 1, unlock: "nfc", lat: 47.11, lon: 15.12, clue: "behind the oak", secret: SERIAL },
  { stageNo: 2, unlock: "nfc", lat: 47.12, lon: 15.13, clue: "short code", secret: "1234" },
  { stageNo: 3, unlock: "geo", lat: 47.13, lon: 15.14, clue: "the final" },
];

describe("sealing NFC stages for offline packs", () => {
  it("tells the owner which stages unlock offline, and why the others do not", async () => {
    const { env, id } = await setup();
    const r = (await (await post(env, `/api/caches/${id}/stages`, { ownerCall: "OE8OWN", stages: STAGES })).json()) as {
      offline: { stageNo: number; offline: boolean; reason?: string }[];
    };
    expect(r.offline.map((o) => [o.stageNo, o.offline])).toEqual([
      [0, true],
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(r.offline[2]!.reason).toMatch(/too short/);
    expect(r.offline[3]!.reason).toMatch(/geo stage/);
  });

  it("puts the start in the clear and only the sealed blob of a strong NFC stage in the pack", async () => {
    const { env, id } = await setup();
    await post(env, `/api/caches/${id}/stages`, { ownerCall: "OE8OWN", stages: STAGES });
    const pack = (await (
      await serve(env)(new Request("https://stages.example/api/offline/pack?grid=JN77"))
    ).json()) as PackResponse;
    const stages = pack.caches[0]!.stages;
    expect(stages[0]).toMatchObject({ stageNo: 0, open: { lat: 47.1, lon: 15.1, clue: "start at the bench" } });
    expect(stages[1]!.sealed).toBeDefined();
    expect(stages[2]).toEqual({ stageNo: 2, unlock: "nfc" });
    expect(stages[3]).toEqual({ stageNo: 3, unlock: "geo" });
    const text = JSON.stringify(pack);
    for (const secret of [SERIAL, "behind the oak", "47.11", "1234", "the final", "47.13"])
      expect(text).not.toContain(secret);
    expect(await openSealedStage(SERIAL.toLowerCase(), stages[1]!.sealed!)).toEqual({
      lat: 47.11,
      lon: 15.12,
      clue: "behind the oak",
      mediaUrl: null,
    });
  });

  it("reseals a stage when its audio clue changes, and the unlock online still checks the code", async () => {
    const { env, id } = await setup();
    await post(env, `/api/caches/${id}/stages`, { ownerCall: "OE8OWN", stages: STAGES });
    const up = await serve(env)(
      new Request(`https://stages.example/api/caches/${id}/stages/1/media`, {
        method: "PUT",
        headers: { "content-type": "audio/mpeg", ...OWNER },
        body: new Uint8Array(100),
      }),
    );
    expect(up.status, await up.clone().text()).toBe(200);
    const pack = (await (
      await serve(env)(new Request("https://stages.example/api/offline/pack?grid=JN77"))
    ).json()) as PackResponse;
    const opened = await openSealedStage(SERIAL, pack.caches[0]!.stages[1]!.sealed!);
    expect(opened?.mediaUrl).toMatch(/^\/api\/media\/cache\/\d+\/stage\/1\/clue-[0-9a-f]+\./);
    const wrong = await post(env, `/api/caches/${id}/stages/1/unlock`, { callsign: "OE8FND", code: "nope" });
    expect(wrong.status).toBe(403);
    const right = await post(env, `/api/caches/${id}/stages/1/unlock`, { callsign: "OE8FND", code: SERIAL });
    expect(((await right.json()) as { unlocked: boolean }).unlocked).toBe(true);
  });
});
