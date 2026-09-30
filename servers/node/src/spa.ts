// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The built SPA (apps/web/dist), served by the Node server itself when WEB_DIST names it — for a box with
 * no reverse proxy in front (a phone in Termux, a bare-metal service). The SPA and the API then share one
 * origin, which sessions and passkeys rely on. Caddy does the same job in the Docker stack and the desktop
 * app in its own launcher; the gateway's paths (isGatewayPath) never reach this.
 */
import fs from "node:fs";
import path from "node:path";

export interface SpaFile {
  file: string;
  contentType: string;
  cacheControl: string;
}

const HTML = "text/html; charset=utf-8";
const TYPES: Record<string, string> = {
  html: HTML,
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  txt: "text/plain; charset=utf-8",
  pmtiles: "application/octet-stream",
  wasm: "application/wasm",
};

const typeOf = (file: string) => TYPES[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

const isFile = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * The file that answers `pathname` from the build in `root`: the file itself, or index.html for a
 * client-side route (a path whose last segment has no extension). Null when nothing answers — a missing
 * asset stays a 404 rather than an HTML page the browser would run as a script. Build assets carry a
 * content hash in their name, so they cache for good; index.html is revalidated on every load, so an
 * update reaches the browser on its next visit.
 */
export function spaFile(root: string, pathname: string): SpaFile | null {
  const base = path.resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const index = path.join(base, "index.html");
  const wanted = path.resolve(base, "." + path.posix.normalize("/" + decoded));
  const inside = wanted.startsWith(base + path.sep);
  if (inside && isFile(wanted) && wanted !== index)
    return {
      file: wanted,
      contentType: typeOf(wanted),
      cacheControl: wanted.startsWith(path.join(base, "assets") + path.sep)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
  if (path.extname(decoded) !== "" && decoded !== "/index.html") return null;
  return isFile(index) ? { file: index, contentType: HTML, cacheControl: "no-cache" } : null;
}
