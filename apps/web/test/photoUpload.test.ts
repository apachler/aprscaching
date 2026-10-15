// SPDX-License-Identifier: AGPL-3.0-or-later
// Every photo goes up re-encoded through a canvas, whatever its size, so none keeps the metadata its camera wrote;
// it is decoded upright, and only a GIF that fits goes up as the file it is.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitWithin, photoForUpload, PHOTO_PX, thumbnailOf, uploadsAsIs } from "../src/media/resize.js";

describe("fitWithin", () => {
  it("scales the longest side down to the bound and keeps the aspect", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it("keeps a photo that already fits at its own size, never smaller than a pixel", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

describe("uploadsAsIs", () => {
  it("only a GIF that fits, so its animation survives", () => {
    expect(uploadsAsIs("image/gif", 400, 300)).toBe(true);
    expect(uploadsAsIs("image/gif", PHOTO_PX + 1, 300)).toBe(false);
    for (const t of ["image/jpeg", "image/png", "image/webp", "image/avif"])
      expect(uploadsAsIs(t, 400, 300)).toBe(false);
  });
});

/** A browser whose decoder hands back a bitmap of the given (already upright) size and whose canvas records its use. */
function fakeBrowser(width: number, height: number, decodes = true) {
  const decoded: unknown[] = [];
  const canvases: { width: number; height: number; type?: string }[] = [];
  vi.stubGlobal("createImageBitmap", async (_blob: Blob, options: unknown) => {
    decoded.push(options);
    if (!decodes) throw new Error("unsupported");
    return { width, height, close: () => {} };
  });
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      record: { width: number; height: number; type?: string };
      constructor(w: number, h: number) {
        this.record = { width: w, height: h };
        canvases.push(this.record);
      }
      getContext() {
        return { fillRect: () => {}, drawImage: () => {}, fillStyle: "" };
      }
      async convertToBlob(o: { type: string }) {
        this.record.type = o.type;
        return new Blob(["clean"], { type: o.type });
      }
    },
  );
  return { decoded, canvases };
}

afterEach(() => vi.unstubAllGlobals());

describe("photoForUpload", () => {
  it("re-encodes a photo that is already small, decoding it upright", async () => {
    const b = fakeBrowser(600, 800);
    const camera = new Blob(["exif+gps"], { type: "image/jpeg" });
    const out = await photoForUpload(camera);
    expect(out).not.toBe(camera);
    expect(out.type).toBe("image/jpeg");
    expect(b.decoded).toEqual([{ imageOrientation: "from-image" }]);
    expect(b.canvases).toEqual([{ width: 600, height: 800, type: "image/jpeg" }]);
  });

  it("scales a large photo down to PHOTO_PX", async () => {
    const b = fakeBrowser(4000, 3000);
    await photoForUpload(new Blob(["x"], { type: "image/png" }));
    expect(b.canvases[0]).toMatchObject({ width: PHOTO_PX, height: 1200 });
  });

  it("sends a GIF that fits, and a file the browser cannot decode, as they are", async () => {
    fakeBrowser(200, 200);
    const gif = new Blob(["GIF89a"], { type: "image/gif" });
    expect(await photoForUpload(gif)).toBe(gif);
    fakeBrowser(200, 200, false);
    const odd = new Blob(["?"], { type: "image/avif" });
    expect(await photoForUpload(odd)).toBe(odd);
  });
});

describe("thumbnailOf", () => {
  it("always re-encodes, and is null when the browser cannot draw the image", async () => {
    const b = fakeBrowser(100, 50);
    expect((await thumbnailOf(new Blob(["x"], { type: "image/webp" })))?.type).toBe("image/jpeg");
    expect(b.canvases[0]).toMatchObject({ width: 100, height: 50 });
    fakeBrowser(100, 50, false);
    expect(await thumbnailOf(new Blob(["x"], { type: "image/jpeg" }))).toBeNull();
  });
});
