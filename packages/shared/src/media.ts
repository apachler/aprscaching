// SPDX-License-Identifier: MIT
/**
 * How much media a cache may carry. Media fills the instance's disk or bucket, so it is bounded at every level:
 * a photo scaled in the browser to 1600 px is about half a megabyte, and an audio clue runs a few minutes at
 * most. The gateway enforces these; the app checks a file against them before it uploads.
 */
export const MEDIA_LIMITS = {
  /** one photo, in bytes */
  image: 2_000_000,
  /** one sound: a gallery item or a stage's audio clue, in bytes */
  audio: 3_000_000,
  /** gallery items on one cache */
  items: 6,
  /** every item and audio clue on one cache, in bytes */
  cache: 10_000_000,
  /** across every cache of one account, in bytes */
  account: 50_000_000,
} as const;

/** A byte limit as people read it ("3 MB"). */
export const mediaMB = (bytes: number) => `${bytes / 1_000_000} MB`;
