// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CacheStage } from "@aprscaching/shared";

/** One stage as the owner edits it (caches/StagesEditor.tsx). */
export interface StageDraft {
  unlock: CacheStage["unlock"];
  clue: string;
  at: string;
  radiusM: number;
  secret: string;
  /** The stage's number as saved; none for a stage added since. Its clip follows it when the number changes. */
  prev?: number;
  /** An audio clip is stored for the stage as saved. */
  clip: boolean;
}

/**
 * The saved stages whose clip a save of `rows` lets go: the stage is gone, or it stops being an audio stage (the
 * gateway's rule in stages.ts handleSetStages). Numbers as saved. Pure.
 */
export function clipsDropped(
  saved: { stageNo: number; unlock: CacheStage["unlock"]; clip: boolean }[],
  rows: StageDraft[],
): number[] {
  return saved
    .filter((s) => s.clip)
    .filter((s) => {
      const now = rows.find((r) => r.prev === s.stageNo);
      return !now || (s.unlock === "audio" && now.unlock !== "audio");
    })
    .map((s) => s.stageNo);
}
