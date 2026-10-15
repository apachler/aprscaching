// SPDX-License-Identifier: AGPL-3.0-or-later
// A photo uploaded straight from a camera keeps none of its Exif on the instance's disk: the gateway strips the
// metadata before the filesystem store writes the file, and refuses a "photo" it cannot read as its type.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authEnv, call, hiderSignup } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { makeFsMedia } from "../src/media.js";

const latin1 = (s: string) => [...s].map((c) => c.charCodeAt(0));
const segment = (marker: number, body: number[]) => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 255,
  ...body,
];

/** A JPEG as a phone writes it: JFIF, an Exif block with GPS tags, XMP, then the picture. */
const CAMERA_JPEG = new Uint8Array([
  0xff,
  0xd8,
  ...segment(0xe0, [...latin1("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  ...segment(0xe1, [...latin1("Exif\0\0MM"), 0, 42, ...latin1("GPSLatitude 47 4 N GPSLongitude 15 26 E")]),
  ...segment(0xe1, latin1("http://ns.adobe.com/xap/1.0/\0<exif:GPSLatitude>47,4N</exif:GPSLatitude>")),
  ...segment(0xdb, [0, ...new Array<number>(64).fill(1)]),
  ...segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
  ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  0x12,
  0x34,
  0xff,
  0xd9,
]);

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "photo-meta-"));
  const env = authEnv({ MEDIA: makeFsMedia(root) });
  const owner = await hiderSignup(env, "photos@example.test", "OE8PIC");
  const made = await call(
    env,
    "POST",
    "/api/caches",
    { title: "view", type: "traditional", lat: 47, lon: 15 },
    { cookie: owner.cookie },
  );
  const cacheId = made.data.cache.id as number;
  const upload = (body: Uint8Array<ArrayBuffer>, contentType = "image/jpeg") =>
    serve(env)(
      new Request(`https://gw.test/api/caches/${cacheId}/media`, {
        method: "POST",
        headers: { "content-type": contentType, cookie: owner.cookie!, "x-real-ip": "192.0.2.20" },
        body,
      }),
    );
  return { root, env, upload };
}

const filesUnder = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((e) => (e.isFile() ? [path.join(e.parentPath, e.name)] : []));

describe("an uploaded photo's metadata", () => {
  it("is gone from the stored file, and the picture is intact", async () => {
    const w = await world();
    const res = await w.upload(CAMERA_JPEG);
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { bytes: number; url: string } };

    const [file] = filesUnder(w.root).filter((f) => f.endsWith(".jpeg"));
    const stored = fs.readFileSync(file!);
    for (const marker of ["Exif", "GPSLatitude", "ns.adobe.com"]) expect(stored.includes(marker)).toBe(false);
    expect(stored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(stored.includes(Buffer.from("JFIF\0"))).toBe(true);
    expect(stored.subarray(-4)).toEqual(Buffer.from([0x12, 0x34, 0xff, 0xd9]));
    expect(item.bytes).toBe(stored.length);

    const served = Buffer.from(await (await serve(w.env)(new Request(`https://gw.test${item.url}`))).arrayBuffer());
    expect(served.equals(stored)).toBe(true);
  });

  it("refuses a file that does not read as the photo type it was sent as", async () => {
    const w = await world();
    const res = await w.upload(CAMERA_JPEG, "image/png");
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not read as PNG/);
    expect(filesUnder(w.root)).toEqual([]);
  });
});
