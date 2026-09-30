// SPDX-License-Identifier: AGPL-3.0-or-later
// With WEB_DIST set, the Node server serves the built SPA from the same origin as the API, the way the
// desktop app and Caddy do: every path the gateway claims goes to the gateway, everything else is a file
// from the build or, for a client-side route, its index.html. A path never escapes the build directory.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spaFile } from "../src/spa.js";

function dist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-spa-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), "{}");
  fs.writeFileSync(path.join(path.dirname(dir), "outside.txt"), "secret");
  return dir;
}

describe("spaFile", () => {
  it("serves index.html for / and never caches it", () => {
    const root = dist();
    const f = spaFile(root, "/");
    expect(f?.file).toBe(path.join(root, "index.html"));
    expect(f?.contentType).toBe("text/html; charset=utf-8");
    expect(f?.cacheControl).toBe("no-cache");
  });

  it("serves a hashed build asset with its type and a long cache", () => {
    const root = dist();
    const f = spaFile(root, "/assets/index-abc123.js");
    expect(f?.file).toBe(path.join(root, "assets", "index-abc123.js"));
    expect(f?.contentType).toBe("text/javascript");
    expect(f?.cacheControl).toContain("immutable");
    expect(spaFile(root, "/manifest.webmanifest")?.contentType).toBe("application/manifest+json");
  });

  it("answers a client-side route with index.html", () => {
    const root = dist();
    expect(spaFile(root, "/cache/AC1234")?.file).toBe(path.join(root, "index.html"));
    expect(spaFile(root, "/settings/")?.file).toBe(path.join(root, "index.html"));
  });

  it("a missing asset is not answered with index.html", () => {
    const root = dist();
    expect(spaFile(root, "/assets/gone-000.js")).toBeNull();
  });

  it("never resolves a path outside the build directory", () => {
    const root = dist();
    for (const p of ["/../outside.txt", "/assets/../../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt"]) {
      const f = spaFile(root, p);
      expect(f === null || f.file.startsWith(root + path.sep)).toBe(true);
    }
  });

  it("returns null when the build is missing", () => {
    expect(spaFile(path.join(os.tmpdir(), "acs-spa-none-" + process.pid), "/")).toBeNull();
  });
});

describe("the Node server wires the SPA", () => {
  it("serves it only when WEB_DIST is set and only for paths the gateway does not claim", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const server = fs.readFileSync(path.join(here, "../src/server.ts"), "utf8");
    const listen = fs.readFileSync(path.join(here, "../src/listen.ts"), "utf8");
    expect(server).toContain("process.env.WEB_DIST");
    expect(listen).toContain("opts.webDist && !isGatewayPath(pathname)");
  });
});
