// SPDX-License-Identifier: AGPL-3.0-or-later
// A multi-stage cache with no connection: the published start shows from the pack, an NFC stage the pack
// carries sealed opens with its tag code on the phone and is queued for the instance to confirm, and any
// other stage says it needs a connection.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { sealStage, type PackCache } from "@aprscaching/shared";
import { getStages, queuedLogs, unlockStage, offlineReady } from "../src/api.js";

const SERIAL = "04:A2:5F:1B:3C:80:90";

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
});
afterEach(() => vi.unstubAllGlobals());

async function seed() {
  const sealed = await sealStage(SERIAL, { lat: 47.11, lon: 15.12, clue: "behind the oak", mediaUrl: null }, 1000);
  const cache = {
    globalId: "x:cache:77",
    id: 77,
    code: "AC-MS",
    stages: [
      { stageNo: 0, unlock: "open", open: { lat: 47.1, lon: 15.1, clue: "start at the bench", mediaUrl: null } },
      { stageNo: 1, unlock: "nfc", sealed },
      { stageNo: 2, unlock: "geo" },
    ],
  } as unknown as PackCache;
  const st = await offlineReady();
  await st.putPack(
    {
      id: "p-stages",
      name: "JN77",
      area: { locator: "JN77" },
      filters: { types: [] },
      images: "none",
      instance: "x",
      createdAt: 1,
      refreshedAt: 1,
      generation: "g",
      cacheCount: 1,
      sizeBytes: 1,
    },
    [cache],
  );
}

describe("stages without a connection", () => {
  it("shows the start, opens an NFC stage with its code, and queues the unlock for the instance", async () => {
    await seed();
    const before = (await getStages(77, "OE8FND")).stages;
    expect(before.map((s) => [s.stageNo, s.unlocked, s.offline])).toEqual([
      [0, true, false],
      [1, false, true],
      [2, false, false],
    ]);
    expect(before[0]).toMatchObject({ lat: 47.1, clue: "start at the bench" });

    expect(await unlockStage(77, 1, "OE8FND", undefined, "wrong-code-123")).toEqual({
      unlocked: false,
      reason: "bad_code",
    });
    const r = await unlockStage(77, 1, "OE8FND", undefined, SERIAL.toLowerCase());
    expect(r).toEqual({ unlocked: true, lat: 47.11, lon: 15.12, offline: true });

    const after = (await getStages(77, "OE8FND")).stages;
    expect(after[1]).toMatchObject({ unlocked: true, lat: 47.11, clue: "behind the oak" });
    const queued = await queuedLogs();
    expect(queued.at(-1)).toMatchObject({
      cacheId: 77,
      kind: "unlock",
      stageNo: 1,
      body: { loggerCall: "OE8FND", code: SERIAL.toLowerCase() },
    });
  });

  it("says a geo stage needs a connection", async () => {
    await seed();
    expect(await unlockStage(77, 2, "OE8FND", { lat: 47.12, lon: 15.13 })).toEqual({
      unlocked: false,
      reason: "needs_connection",
    });
  });
});
