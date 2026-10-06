// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Compression of the built SPA's static files, for a gateway that serves them itself (the Node server with
 * WEB_DIST, the desktop app) with no Caddy in front to do it. Text assets (scripts, styles, HTML, JSON, SVG)
 * go out as brotli or gzip when the request's Accept-Encoding allows, which cuts the app shell to about a
 * third on a phone link. Images, fonts and tiles are already compressed and go out as they are.
 *
 * Each compressed body is made once, off the event loop (zlib's thread pool), and kept in a bounded
 * in-memory cache keyed by the file and its version, so a rebuild invalidates it and a Pi does not spend
 * a second of CPU on every page load.
 */
import zlib from "node:zlib";
import { promisify } from "node:util";

export type Encoding = "br" | "gzip";

/** Below this a compressed body saves less than the header costs. */
export const MIN_COMPRESS_BYTES = 1024;
/** The cache's ceiling: a build's compressed text assets fit many times over. */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** A content type worth compressing: text, scripts, JSON, SVG, the manifest and WebAssembly. */
export function compressible(contentType: string): boolean {
  const t = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    t.startsWith("text/") ||
    t === "application/json" ||
    t === "application/manifest+json" ||
    t === "application/wasm" ||
    t === "image/svg+xml" ||
    t === "image/x-icon"
  );
}

/**
 * The encoding to answer with: brotli when the client takes it, else gzip, else none. A coding listed
 * with q=0 is refused; `*` admits both.
 */
export function pickEncoding(acceptEncoding: string | null | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const q = new Map<string, number>();
  for (const part of acceptEncoding.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const v = qp ? Number(qp.slice(2)) : 1;
    q.set(name.trim(), Number.isFinite(v) ? v : 0);
  }
  const ok = (name: Encoding) => (q.get(name) ?? (q.has("*") ? q.get("*")! : 0)) > 0;
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return null;
}

const cache = new Map<string, Promise<Buffer>>();
const sizes = new Map<string, number>();
let cachedBytes = 0;

function remember(key: string, body: Buffer): void {
  sizes.set(key, body.length);
  cachedBytes += body.length;
  // oldest first: a Map iterates in insertion order
  for (const k of cache.keys()) {
    if (cachedBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    cachedBytes -= sizes.get(k) ?? 0;
    sizes.delete(k);
  }
}

/**
 * The body `load` returns, compressed with `enc`; from the cache when `key` (the file and its version: path, size
 * and mtime, or an embedded asset's path) has been compressed before.
 */
export function compressed(key: string, enc: Encoding, load: () => Uint8Array | Promise<Uint8Array>): Promise<Buffer> {
  const k = `${enc}\0${key}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const made = Promise.resolve()
    .then(load)
    .then((data) =>
      enc === "br"
        ? brotli(data, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
            },
          })
        : gzip(data, { level: 9 }),
    )
    .then(
      (body) => {
        remember(k, body);
        return body;
      },
      (e: unknown) => {
        cache.delete(k);
        throw e;
      },
    );
  cache.set(k, made);
  return made;
}

/**
 * How a static file answers a request: the encoding to use (null for the bytes as they are) and whether
 * the answer varies by Accept-Encoding. A Range request gets the plain bytes, so a byte range always
 * means the file's own bytes.
 */
export function negotiate(
  contentType: string,
  size: number,
  headers: { acceptEncoding?: string | null; range?: string | null },
): { encoding: Encoding | null; vary: boolean } {
  if (!compressible(contentType) || size < MIN_COMPRESS_BYTES) return { encoding: null, vary: false };
  if (headers.range) return { encoding: null, vary: true };
  return { encoding: pickEncoding(headers.acceptEncoding), vary: true };
}
