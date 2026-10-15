// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Preparing a photo in the browser before it is uploaded. Every photo is drawn onto a canvas and encoded afresh,
 * whatever its size: the canvas writes none of the Exif, XMP or IPTC the camera put in the file (the place the
 * photo was taken among them), and it scales the photo down to no larger than the page shows. The instance has no
 * image resizer on every runtime, so this is also where the small copy for galleries and offline packs is made.
 * The gateway removes any metadata a file still carries, for a client that skips this step.
 */

/** The longest side of a cache photo as stored, and of its thumbnail, in pixels. */
export const PHOTO_PX = 1600;
const THUMB_PX = 320;

/**
 * The pixel size an image of `width` × `height` is encoded at so its longest side is at most `maxPx`: scaled
 * down when larger, its own size otherwise, never smaller than one pixel.
 */
export function fitWithin(width: number, height: number, maxPx: number): { width: number; height: number } {
  const scale = Math.min(1, maxPx / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Whether a photo goes up as the file it is rather than re-encoded: only a GIF that already fits, since the
 * canvas keeps one frame of an animation. The gateway strips a GIF's comments and XMP on arrival.
 */
export function uploadsAsIs(type: string, width: number, height: number): boolean {
  return type === "image/gif" && Math.max(width, height) <= PHOTO_PX;
}

/**
 * The image decoded upright: `from-image` applies the orientation the camera recorded in Exif to the pixels,
 * so the re-encoded photo, which carries no Exif, still stands the right way up.
 */
async function decode(blob: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

/** The bitmap drawn at most `maxPx` on its longest side and encoded as a JPEG; null when the canvas fails. */
async function encodeJpeg(bmp: ImageBitmap, maxPx: number, quality: number): Promise<Blob | null> {
  try {
    const size = fitWithin(bmp.width, bmp.height, maxPx);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // JPEG has no transparency: a transparent area lands on white paper, not on black
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(bmp, 0, 0, size.width, size.height);
    return await canvas.convertToBlob({ type: "image/jpeg", quality });
  } catch {
    return null;
  }
}

/**
 * The photo as it is uploaded: re-encoded as a JPEG of at most PHOTO_PX, with no metadata. A GIF that fits goes
 * up as it is (see {@link uploadsAsIs}), and so does a file this browser cannot decode, which the gateway then
 * strips or refuses.
 */
export async function photoForUpload(file: Blob): Promise<Blob> {
  const bmp = await decode(file);
  if (!bmp) return file;
  try {
    if (uploadsAsIs(file.type, bmp.width, bmp.height)) return file;
    return (await encodeJpeg(bmp, PHOTO_PX, 0.85)) ?? file;
  } finally {
    bmp.close();
  }
}

/** A thumbnail of an image, re-encoded as a JPEG of at most THUMB_PX; null when the browser cannot draw it. */
export async function thumbnailOf(blob: Blob): Promise<Blob | null> {
  const bmp = await decode(blob);
  if (!bmp) return null;
  try {
    return await encodeJpeg(bmp, THUMB_PX, 0.72);
  } finally {
    bmp.close();
  }
}
