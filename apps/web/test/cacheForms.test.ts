// SPDX-License-Identifier: AGPL-3.0-or-later
// The cache and log forms check their limits before sending, word a schema refusal as the field it is about, and
// the stage editor knows which clips a save deletes.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { MEDIA_LIMITS, TEXT_LIMITS } from "@aprscaching/shared";
import { ApiError } from "../src/api.js";
import { parseTags, refusalMessage, tagProblem } from "../src/caches/formLimits.js";
import { clipsDropped, type StageDraft } from "../src/caches/stageEdits.js";
import { mediaUploadProblem } from "../src/media/limits.js";

describe("cache tags", () => {
  it("are trimmed, at most as many as a cache takes, and a long one is named", () => {
    expect(parseTags(" scenic, ,family ")).toEqual(["scenic", "family"]);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(","))).toHaveLength(TEXT_LIMITS.tags);
    expect(tagProblem(["ok"])).toBeNull();
    expect(tagProblem(["x".repeat(TEXT_LIMITS.tag + 1)])).toMatch(`${TEXT_LIMITS.tag} characters`);
  });
});

describe("a schema refusal", () => {
  const refused = (issues: unknown[]) => new ApiError("bad request", 400, { error: "bad request", issues });
  it("names the field and its limit", () => {
    expect(
      refusalMessage(refused([{ code: "too_big", origin: "string", maximum: 120, path: ["title"], message: "x" }])),
    ).toBe("Title: at most 120 characters.");
    expect(
      refusalMessage(refused([{ code: "too_big", origin: "string", maximum: 24, path: ["tags", 2], message: "x" }])),
    ).toBe("Tags: each is at most 24 characters.");
    expect(refusalMessage(refused([{ code: "invalid_type", path: ["comment"], message: "Expected string" }]))).toBe(
      "Comment: Expected string.",
    );
  });
  it("leaves any other refusal as the server said it", () => {
    expect(refusalMessage(new ApiError("only the owner may edit", 403, {}))).toBe("only the owner may edit");
  });
});

describe("a gallery upload", () => {
  it("is checked against the instance's limits before it is sent", () => {
    expect(mediaUploadProblem("image/jpeg", 1000)).toBeNull();
    expect(mediaUploadProblem("audio/mpeg", MEDIA_LIMITS.audio + 1)).toMatch(/at most 3 MB/);
    expect(mediaUploadProblem("image/png", MEDIA_LIMITS.image + 1)).toMatch(/at most 2 MB/);
    expect(mediaUploadProblem("application/pdf", 10)).toMatch(/photo or a sound/);
  });
});

describe("saving the stages", () => {
  const row = (unlock: StageDraft["unlock"], prev?: number): StageDraft => ({
    unlock,
    clue: "",
    at: "",
    radiusM: 60,
    secret: "",
    prev,
    clip: false,
  });
  const saved = [
    { stageNo: 0, unlock: "open" as const, clip: false },
    { stageNo: 1, unlock: "audio" as const, clip: true },
    { stageNo: 2, unlock: "audio" as const, clip: true },
  ];
  it("keeps the clip of a stage that moved up, and deletes the removed stage's", () => {
    expect(clipsDropped(saved, [row("open", 0), row("audio", 2)])).toEqual([1]);
  });
  it("deletes the clip of a stage that stops being an audio stage", () => {
    expect(clipsDropped(saved, [row("open", 0), row("geo", 1), row("audio", 2)])).toEqual([1]);
    expect(clipsDropped(saved, [row("open", 0), row("audio", 1), row("audio", 2), row("geo")])).toEqual([]);
  });
});
