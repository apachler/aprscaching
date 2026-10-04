// SPDX-License-Identifier: AGPL-3.0-or-later
// A refused stage unlock is an answer with a reason, online and when the offline queue confirms it later: the
// finder reads why (too far, wrong code), never an HTTP status.
import "fake-indexeddb/auto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { sealStage, type PackCache } from "@aprscaching/shared";
import { attentionLogs, flushLogQueue, offlineReady, unlockStage } from "../src/api.js";
import { stageRefusalText } from "../src/log/stageUnlock.js";

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("a refused stage unlock", () => {
  it("comes back with its reason and distance instead of an error", async () => {
    vi.stubGlobal(
      "fetch",
      answer(403, { error: "too far", unlocked: false, reason: "too_far", distanceM: 420, radiusM: 60 }),
    );
    expect(await unlockStage(5, 2, "OE8FND", { lat: 47, lon: 15 })).toEqual({
      unlocked: false,
      reason: "too_far",
      distanceM: 420,
    });
    vi.stubGlobal("fetch", answer(403, { unlocked: false, reason: "bad_code" }));
    expect(await unlockStage(5, 2, "OE8FND", undefined, "nope")).toEqual({ unlocked: false, reason: "bad_code" });
  });

  it("still throws for a refusal that names no reason", async () => {
    vi.stubGlobal("fetch", answer(404, { error: "no such stage" }));
    await expect(unlockStage(5, 9, "OE8FND")).rejects.toThrow("no such stage");
  });

  it("is worded for the finder", () => {
    expect(stageRefusalText("too_far", "420 m")).toBe("Too far — 420 m away.");
    expect(stageRefusalText("bad_code")).toBe("That tag/code doesn't match this stage.");
    expect(stageRefusalText("limited")).toMatch(/an hour/);
    expect(stageRefusalText("something new")).toBe("Not unlocked yet.");
  });

  it("refused when the queue confirms an offline unlock, shows the reason in Needs attention", async () => {
    const SERIAL = "04:A2:5F:1B:3C:80:91";
    const sealed = await sealStage(SERIAL, { lat: 47.11, lon: 15.12, clue: null, mediaUrl: null }, 1000);
    const cache = {
      globalId: "x:cache:88",
      id: 88,
      code: "AC-NA",
      stages: [
        { stageNo: 0, unlock: "open" },
        { stageNo: 1, unlock: "nfc", sealed },
      ],
    } as unknown as PackCache;
    await (
      await offlineReady()
    ).putPack(
      {
        id: "p-attention",
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
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    expect(await unlockStage(88, 1, "OE8FND", undefined, SERIAL)).toMatchObject({ unlocked: true, offline: true });
    vi.stubGlobal("fetch", answer(403, { unlocked: false, reason: "bad_code" }));
    // back online: the instance refuses the code when the queue confirms it
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    await flushLogQueue();
    Object.defineProperty(navigator, "onLine", { value: undefined, configurable: true });
    const attention = await attentionLogs();
    expect(attention.find((a) => a.cacheId === 88)?.reason).toBe("That tag/code doesn't match this stage.");
  });
});
