// SPDX-License-Identifier: AGPL-3.0-or-later
import { MEDIA_LIMITS, mediaMB } from "@aprscaching/shared";

/**
 * Why a gallery file would be refused by the instance, or null when it fits: the same kinds and sizes the gateway
 * takes (MEDIA_LIMITS), checked before the bytes are sent. A photo is checked as it goes up, after scaling.
 */
export function mediaUploadProblem(type: string, bytes: number): string | null {
  const kind = type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" : null;
  if (!kind) return "Media must be a photo or a sound (JPEG, PNG, WebP, GIF, AVIF, MP3, Ogg, WAV, M4A).";
  if (!bytes) return "That file is empty.";
  const max = MEDIA_LIMITS[kind];
  return bytes > max ? `${kind === "image" ? "A photo" : "A sound"} is at most ${mediaMB(max)}.` : null;
}
