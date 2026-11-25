// SPDX-License-Identifier: AGPL-3.0-or-later
// A profile's picture is uploaded to the instance and served from it: a profile never names a picture on another
// host, whose owner would learn each visitor's address. The stored file carries none of the camera's metadata,
// shows while the profile is public (to its owner while hidden), and leaves the store when it is replaced, removed,
// erased with the account or cleared by moderation.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { makeFsMedia } from "../src/media.js";
import type { Env } from "@aprscaching/gateway/env";

const latin1 = (s: string) => [...s].map((c) => c.charCodeAt(0));
const segment = (marker: number, body: number[]) => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 255,
  ...body,
];
/** A JPEG as a phone writes it, its Exif block naming where it was taken. */
const CAMERA_JPEG = new Uint8Array([
  0xff,
  0xd8,
  ...segment(0xe0, [...latin1("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  ...segment(0xe1, [...latin1("Exif\0\0MM"), 0, 42, ...latin1("GPSLatitude 47 4 N GPSLongitude 15 26 E")]),
  ...segment(0xdb, [0, ...new Array<number>(64).fill(1)]),
  ...segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
  ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  0x12,
  0x34,
  0xff,
  0xd9,
]);

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-"));
  const env = authEnv({ MEDIA: makeFsMedia(root), ADMIN_CALLSIGNS: "OE8APR" });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  await operatorVerify(env, "OE8APR");
  const me = await emailSignup(env, "me@example.test", "DL1PIC", nextIp());
  expect(me.status).toBe(200);
  return { root, env, me, sysop };
}
const put = (env: Env, who: Res, body: Uint8Array<ArrayBuffer>, contentType = "image/jpeg") =>
  serve(env)(
    new Request("https://gw.test/api/my/avatar", {
      method: "PUT",
      headers: { "content-type": contentType, cookie: who.cookie, "x-real-ip": "192.0.2.30" },
      body,
    }),
  );
const get = (env: Env, url: string, who?: Res) =>
  serve(env)(new Request(`https://gw.test${url}`, { headers: who ? { cookie: who.cookie } : {} }));
const stored = (root: string) =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .flatMap((e) => (e.isFile() && !e.name.endsWith(".ct") ? [e.name] : []));
const show = (env: Env, who: Res, profilePublic: boolean) =>
  call(env, "POST", "/auth/profile", { displayName: "Pic", profilePublic }, { cookie: who.cookie });

describe("a profile's picture", () => {
  it("is never an address on another host", async () => {
    const { env, me } = await world();
    const saved = await call(
      env,
      "POST",
      "/auth/profile",
      { displayName: "Pic", avatarUrl: "https://tracker.example/me.png", profilePublic: true },
      { cookie: me.cookie },
    );
    expect(saved.status).toBe(200);
    expect(saved.data.profile.avatarUrl).toBeNull();
    const pub = await call(env, "GET", "/api/profile/DL1PIC");
    expect(JSON.stringify(pub.data)).not.toContain("tracker.example");
    const mine = await call(env, "GET", "/api/my/profile", undefined, { cookie: me.cookie });
    expect(mine.data.profile.avatarUrl).toBeNull();
  });

  it("is uploaded, stored without the camera's metadata, and served from this instance", async () => {
    const { env, me } = await world();
    await show(env, me, true);
    const res = await put(env, me, CAMERA_JPEG);
    expect(res.status).toBe(200);
    const url = ((await res.json()) as { avatarUrl: string }).avatarUrl;
    expect(url).toMatch(/^\/api\/media\/avatar\/[0-9a-f-]{36}\.jpeg$/);
    expect((await call(env, "GET", "/api/profile/DL1PIC")).data.profile.avatarUrl).toBe(url);
    const pic = await get(env, url);
    expect(pic.status).toBe(200);
    expect(pic.headers.get("content-type")).toBe("image/jpeg");
    expect(pic.headers.get("content-security-policy")).toContain("sandbox");
    const bytes = Buffer.from(await pic.arrayBuffer()).toString("latin1");
    expect(bytes).not.toContain("GPSLatitude");
  });

  it("refuses what is not a photo, and a photo over its size", async () => {
    const { env, me } = await world();
    expect((await put(env, me, new Uint8Array(latin1("<svg onload=x>")), "image/svg+xml")).status).toBe(415);
    expect((await put(env, me, new Uint8Array(300_000).fill(1))).status).toBe(413);
    const anon = await serve(env)(new Request("https://gw.test/api/my/avatar", { method: "PUT", body: CAMERA_JPEG }));
    expect(anon.status).toBe(401);
  });

  it("shows while the profile is public, and to its owner alone while hidden", async () => {
    const { env, me, sysop } = await world();
    await show(env, me, false);
    const url = ((await (await put(env, me, CAMERA_JPEG)).json()) as { avatarUrl: string }).avatarUrl;
    expect((await get(env, url)).status).toBe(404);
    expect((await get(env, url, sysop)).status).toBe(404);
    const own = await get(env, url, me);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
    await show(env, me, true);
    expect((await get(env, url)).status).toBe(200);
  });

  it("leaves the store when it is replaced or removed", async () => {
    const { root, env, me } = await world();
    const first = ((await (await put(env, me, CAMERA_JPEG)).json()) as { avatarUrl: string }).avatarUrl;
    const second = ((await (await put(env, me, CAMERA_JPEG)).json()) as { avatarUrl: string }).avatarUrl;
    expect(second).not.toBe(first);
    expect(stored(root)).toEqual([path.basename(second)]);
    expect((await call(env, "DELETE", "/api/my/avatar", undefined, { cookie: me.cookie })).status).toBe(200);
    expect(stored(root)).toEqual([]);
    expect(
      (await call(env, "GET", "/api/my/profile", undefined, { cookie: me.cookie })).data.profile.avatarUrl,
    ).toBeNull();
  });

  it("is in the account's export, and leaves the store with the erased account", async () => {
    const { root, env, me } = await world();
    await put(env, me, CAMERA_JPEG);
    const exp = await call(env, "POST", "/api/account/DL1PIC/export", {}, { cookie: me.cookie });
    expect(exp.data.account.avatar_key).toMatch(/^avatar\//);
    expect(stored(root)).toHaveLength(1);
    expect((await call(env, "POST", "/api/account/DL1PIC/delete", {}, { cookie: me.cookie })).status).toBe(200);
    expect(stored(root)).toEqual([]);
  });

  it("is cleared by a moderation removal of the profile, file included", async () => {
    const { root, env, me, sysop } = await world();
    await show(env, me, true);
    const url = ((await (await put(env, me, CAMERA_JPEG)).json()) as { avatarUrl: string }).avatarUrl;
    const rm = await call(
      env,
      "POST",
      "/api/admin/moderation/remove",
      { kind: "profile", id: "DL1PIC", reason: "offensive picture" },
      { cookie: sysop.cookie },
    );
    expect(rm.status).toBe(200);
    expect(stored(root)).toEqual([]);
    expect((await get(env, url)).status).toBe(404);
  });
});
