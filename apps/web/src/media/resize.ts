// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shrinking an image in the browser before it is uploaded: the instance stores what it receives and has
 * no image resizer on every runtime, so the uploader's browser sends a photo no larger than the page
 * shows, and a small copy for galleries and offline packs.
 */

/** The longest side of a cache photo as stored, and of its thumbnail, in pixels. */
export const PHOTO_PX = 1600;
export const THUMB_PX = 320;

/**
 * The image scaled down so its longest side is at most `maxPx`, as a JPEG; null when the browser cannot
 * draw it (no createImageBitmap or OffscreenCanvas, or a format it does not decode). An image already that
 * small comes back null too, so the caller keeps the original.
 */
export async function resizeImage(blob: Blob, maxPx: number, quality: number): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = maxPx / Math.max(bmp.width, bmp.height);
    if (scale >= 1) {
      bmp.close();
      return null;
    }
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await canvas.convertToBlob({ type: "image/jpeg", quality });
  } catch {
    return null;
  }
}

/** A thumbnail of an image: scaled down, or the image itself re-encoded as JPEG when it is already small. */
export async function thumbnailOf(blob: Blob): Promise<Blob | null> {
  const small = await resizeImage(blob, THUMB_PX, 0.72);
  if (small) return small;
  return blob.type === "image/jpeg" || blob.type === "image/webp" ? blob : null;
}
