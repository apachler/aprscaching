// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The instance's offline map. The operator provides one regional PMTiles archive of vector tiles (an
 * OpenStreetMap extract, e.g. cut from a Protomaps build): on Node and Bun a file (OFFLINE_TILES_PATH),
 * on Cloudflare an object in the TILES bucket (OFFLINE_TILES_KEY), served here at /tiles/offline.pmtiles
 * by byte range; or a copy hosted elsewhere that allows offline use (OFFLINE_TILES_URL). A phone making an
 * offline pack reads the archive's directory and fetches only the tiles of its pack's square.
 *
 * Nothing here contacts a third-party tile service: the tiles are the operator's own.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";

export const TILES_PATH = "/tiles/offline.pmtiles";
/** The largest range one request may read: a PMTiles directory or a run of tiles, never the whole file. */
const MAX_RANGE = 16 * 1024 * 1024;

const tileHeaders = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-range, content-length, etag, accept-ranges",
  "accept-ranges": "bytes",
};

/** GET /api/offline/tiles — where the offline map comes from, or `{url: null}` when there is none. */
export async function handleOfflineTiles(_req: Request, env: Env): Promise<Response> {
  const url = env.OFFLINE_TILES_URL || ((await env.TILES?.stat()) ? TILES_PATH : null);
  return json({
    url,
    attribution: env.OFFLINE_TILES_ATTRIBUTION || "© OpenStreetMap contributors",
    maxZoom: Number(env.OFFLINE_TILES_MAXZOOM) > 0 ? Number(env.OFFLINE_TILES_MAXZOOM) : 14,
  });
}

/** GET|HEAD /tiles/offline.pmtiles — the archive by byte range (one range per request). */
export async function handleTileArchive(req: Request, env: Env): Promise<Response> {
  const st = await env.TILES?.stat();
  if (!env.TILES || !st) return new Response("no offline map on this instance", { status: 404 });
  const etag = `"${st.etag}"`;
  const base = {
    ...tileHeaders,
    etag,
    "content-type": "application/vnd.pmtiles",
    "cache-control": "public, max-age=3600",
  };
  if (req.method === "HEAD") return new Response(null, { headers: { ...base, "content-length": String(st.size) } });
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (!m)
    return new Response("ask for a byte range", {
      status: 416,
      headers: { ...base, "content-range": `bytes */${st.size}` },
    });
  const start = Number(m[1]);
  const end = Math.min(m[2] ? Number(m[2]) : st.size - 1, st.size - 1, start + MAX_RANGE - 1);
  if (start >= st.size || end < start)
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${st.size}` } });
  const bytes = await env.TILES.read(start, end - start + 1);
  return new Response(bytes, {
    status: 206,
    headers: {
      ...base,
      "content-range": `bytes ${start}-${start + bytes.length - 1}/${st.size}`,
      "content-length": String(bytes.length),
    },
  });
}
