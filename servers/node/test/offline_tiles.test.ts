// SPDX-License-Identifier: AGPL-3.0-or-later
// The offline map archive: named by /api/offline/tiles, served by byte range at /tiles/offline.pmtiles
// (one range per request, never the whole file), open to every origin so a phone on any host reads it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { isGatewayPath } from "@aprscaching/gateway/app";
import { fileTiles } from "../src/tiles.js";
import { instanceEnv, serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

function archive(bytes = 4096) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acs-tiles-")), "offline.pmtiles");
  fs.writeFileSync(file, Buffer.from(Array.from({ length: bytes }, (_, i) => i % 251)));
  return file;
}
const env = (file?: string, extra: Record<string, unknown> = {}) =>
  instanceEnv("map.example", null, { TILES: fileTiles(file), ...extra }) as unknown as Env;
const get = (e: Env, p: string, headers: Record<string, string> = {}, method = "GET") =>
  serve(e)(new Request(`https://map.example${p}`, { method, headers }));

describe("the offline map's settings", () => {
  it("name the instance's archive when it has one", async () => {
    const r = (await (await get(env(archive()), "/api/offline/tiles")).json()) as Record<string, unknown>;
    expect(r).toEqual({ url: "/tiles/offline.pmtiles", attribution: "© OpenStreetMap contributors", maxZoom: 14 });
  });
  it("say there is none, or name the copy hosted elsewhere", async () => {
    expect(((await (await get(env(), "/api/offline/tiles")).json()) as { url: unknown }).url).toBeNull();
    expect(((await (await get(env("/no/such/file"), "/api/offline/tiles")).json()) as { url: unknown }).url).toBeNull();
    const hosted = env(undefined, {
      OFFLINE_TILES_URL: "https://maps.example/at.pmtiles",
      OFFLINE_TILES_ATTRIBUTION: "© OSM, Protomaps",
      OFFLINE_TILES_MAXZOOM: "12",
    });
    expect(await (await get(hosted, "/api/offline/tiles")).json()).toEqual({
      url: "https://maps.example/at.pmtiles",
      attribution: "© OSM, Protomaps",
      maxZoom: 12,
    });
  });
});

describe("the archive by byte range", () => {
  it("answers a range with 206 and its bytes, to any origin", async () => {
    const res = await get(env(archive()), "/tiles/offline.pmtiles", { range: "bytes=10-19" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/4096");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toMatch(/content-range/);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
  it("ends an open or overlong range at the end of the file", async () => {
    const res = await get(env(archive()), "/tiles/offline.pmtiles", { range: "bytes=4090-" });
    expect(res.headers.get("content-range")).toBe("bytes 4090-4095/4096");
    expect((await res.arrayBuffer()).byteLength).toBe(6);
  });
  it("refuses the whole file and a range past its end, and says its size", async () => {
    const e = env(archive());
    for (const range of [undefined, "bytes=5000-5010", "bytes=-100"]) {
      const res = await get(e, "/tiles/offline.pmtiles", range ? { range } : {});
      expect(res.status, range).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */4096");
    }
  });
  it("tells its size on HEAD, and 404 without an archive", async () => {
    const head = await get(env(archive()), "/tiles/offline.pmtiles", {}, "HEAD");
    expect(head.headers.get("content-length")).toBe("4096");
    expect((await get(env(), "/tiles/offline.pmtiles", { range: "bytes=0-9" })).status).toBe(404);
  });
  it("is a gateway path, never the web app", () => {
    expect(isGatewayPath("/tiles/offline.pmtiles")).toBe(true);
  });
});
