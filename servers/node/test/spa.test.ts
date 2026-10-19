// SPDX-License-Identifier: AGPL-3.0-or-later
// With WEB_DIST set, the Node server serves the built SPA from the same origin as the API, the way the
// desktop app and Caddy do, compressing text assets for a browser that accepts it: every path the gateway claims goes to the gateway, everything else is a file
// from the build or, for a client-side route, its index.html. A path never escapes the build directory.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { instanceEnv } from "./helpers/fedpeer.js";
import { PAGE_HEADERS } from "@aprscaching/gateway/pageheaders";
import { embeddedSpaFile, spaFile } from "../src/spa.js";
import { createGatewayServer } from "../src/listen.js";
import { pickEncoding } from "../src/compress.js";

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

describe("compressed SPA assets", () => {
  // a script big enough to compress; index-abc123.js is too small to be worth it
  const script = "export const msg = 'hello from the shell';\n".repeat(200);

  async function serve(): Promise<{ port: number; root: string; close: () => Promise<void> }> {
    const root = dist();
    fs.writeFileSync(path.join(root, "assets", "app-def456.js"), script);
    fs.writeFileSync(path.join(root, "assets", "logo-1.png"), Buffer.alloc(4096, 7));
    const server = createGatewayServer({
      env: instanceEnv("localhost", null, { APP_URL: "http://localhost:8787" }),
      rooms: new RoomsCore(),
      webDist: root,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return { port, root, close: () => new Promise((r) => server.close(() => r())) };
  }

  function get(port: number, p: string, headers: Record<string, string> = {}, method = "GET") {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("sends brotli when accepted, gzip as the fallback, and the plain file otherwise", async () => {
    const s = await serve();
    try {
      const br = await get(s.port, "/assets/app-def456.js", { "accept-encoding": "gzip, deflate, br" });
      expect(br.status).toBe(200);
      expect(br.headers["content-encoding"]).toBe("br");
      expect(br.headers.vary).toBe("Accept-Encoding");
      expect(zlib.brotliDecompressSync(br.body).toString()).toBe(script);
      expect(br.body.length).toBeLessThan(script.length / 4);
      // the type and cache headers are those of the plain file
      expect(br.headers["content-type"]).toBe("text/javascript");
      expect(br.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(br.headers["x-content-type-options"]).toBe("nosniff");

      const gz = await get(s.port, "/assets/app-def456.js", { "accept-encoding": "gzip" });
      expect(gz.headers["content-encoding"]).toBe("gzip");
      expect(zlib.gunzipSync(gz.body).toString()).toBe(script);

      const plain = await get(s.port, "/assets/app-def456.js");
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(plain.headers.vary).toBe("Accept-Encoding");
      expect(plain.body.toString()).toBe(script);
      expect(plain.headers["cache-control"]).toBe(br.headers["cache-control"]);

      const refused = await get(s.port, "/assets/app-def456.js", { "accept-encoding": "br;q=0, gzip;q=0" });
      expect(refused.headers["content-encoding"]).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it("leaves images, small files and byte ranges uncompressed", async () => {
    const s = await serve();
    try {
      const png = await get(s.port, "/assets/logo-1.png", { "accept-encoding": "br" });
      expect(png.headers["content-encoding"]).toBeUndefined();
      expect(png.headers.vary).toBeUndefined();
      expect(png.body.length).toBe(4096);

      const small = await get(s.port, "/assets/index-abc123.js", { "accept-encoding": "br" });
      expect(small.headers["content-encoding"]).toBeUndefined();
      expect(small.body.toString()).toBe("console.log(1)");

      const ranged = await get(s.port, "/assets/app-def456.js", { "accept-encoding": "br", range: "bytes=0-9" });
      expect(ranged.headers["content-encoding"]).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it("serves WebAssembly as application/wasm, which instantiateStreaming requires", async () => {
    // the Direwolf modem's own build, as the web app's soundcard path loads it
    const wasm = fs.readFileSync(new URL("../../../modems/direwolf/wasm/direwolf.wasm", import.meta.url));
    const s = await serve();
    try {
      fs.writeFileSync(path.join(s.root, "assets", "direwolf-0a1b2c.wasm"), wasm);
      const url = `http://127.0.0.1:${s.port}/assets/direwolf-0a1b2c.wasm`;
      const res = await fetch(url);
      expect(res.headers.get("content-type")).toBe("application/wasm");
      expect(res.headers.get("cache-control")).toContain("immutable");
      // fetch asks for brotli and gzip, and the module still compiles from the decoded stream
      expect(res.headers.get("content-encoding")).toMatch(/^(br|gzip)$/);
      const mod = await WebAssembly.compileStreaming(res);
      expect(WebAssembly.Module.exports(mod).length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it("a HEAD answers the same headers with no body", async () => {
    const s = await serve();
    try {
      const head = await get(s.port, "/assets/app-def456.js", { "accept-encoding": "br" }, "HEAD");
      expect(head.headers["content-encoding"]).toBe("br");
      expect(head.body.length).toBe(0);
    } finally {
      await s.close();
    }
  });
});

describe("pickEncoding", () => {
  it("prefers brotli, honours q=0 and the wildcard", () => {
    expect(pickEncoding("gzip, br")).toBe("br");
    expect(pickEncoding("gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("*")).toBe("br");
    expect(pickEncoding("*, br;q=0")).toBe("gzip");
    expect(pickEncoding("identity")).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
  });
});

describe("the desktop app compresses its embedded SPA the same way", () => {
  it("negotiates per request with the shared module", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const launcher = fs.readFileSync(path.join(here, "../../../deploy/desktop/launcher.ts"), "utf8");
    expect(launcher).toContain('from "../../servers/node/src/compress.ts"');
    expect(launcher).toContain('req.headers.get("accept-encoding")');
  });
});

describe("the desktop app's embedded build", () => {
  const files = {
    "/index.html": "/$bunfs/index.html",
    "/assets/index-abc123.js": "/$bunfs/assets/index-abc123.js",
    "/sw.js": "/$bunfs/sw.js",
  };

  it("answers a file of the build, with the type and cache of the Node server's answer", () => {
    expect(embeddedSpaFile(files, "/assets/index-abc123.js")).toEqual({
      file: "/$bunfs/assets/index-abc123.js",
      contentType: "text/javascript",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(embeddedSpaFile(files, "/sw.js")?.cacheControl).toBe("no-cache");
    expect(embeddedSpaFile(files, "/")).toEqual({
      file: "/$bunfs/index.html",
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
    });
  });

  it("answers a client-side route with index.html and a missing asset with nothing", () => {
    expect(embeddedSpaFile(files, "/cache/AC1234")?.file).toBe("/$bunfs/index.html");
    expect(embeddedSpaFile(files, "/assets/gone-000.js")).toBeNull();
    expect(embeddedSpaFile(files, "/favicon.ico")).toBeNull();
  });

  it("serves the build with the page headers and a 404 for a missing asset", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const launcher = fs.readFileSync(path.join(here, "../../../deploy/desktop/launcher.ts"), "utf8");
    expect(launcher).toContain("embeddedSpaFile(SPA, pathname)");
    expect(launcher).toContain("spaFile(WEB_DIST, pathname)");
    expect(launcher).toContain("...PAGE_HEADERS");
    expect(launcher).toContain("status: 404");
  });
});

describe("page headers", () => {
  async function serve(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createGatewayServer({
      env: instanceEnv("localhost", null, { APP_URL: "http://localhost:8787" }),
      rooms: new RoomsCore(),
      webDist: dist(),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return { port, close: () => new Promise((r) => server.close(() => r())) };
  }
  it("a Cloudflare Pages copy of the build sends the same headers", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const file = fs.readFileSync(path.join(here, "../../../apps/web/public/_headers"), "utf8");
    const all = /^\/\*\n((?: {2}.+\n)+)/m.exec(file)?.[1] ?? "";
    const sent = Object.fromEntries(
      all.split("\n").flatMap((l) =>
        l.trim()
          ? [
              l
                .trim()
                .split(/: (.*)/s)
                .slice(0, 2),
            ]
          : [],
      ),
    ) as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower).toEqual(PAGE_HEADERS);
  });

  const expectPageHeaders = (res: Response, what: string) => {
    for (const [k, v] of Object.entries(PAGE_HEADERS)) expect(res.headers.get(k), `${what}: ${k}`).toBe(v);
  };

  it("the app's shell, a client-side route and a build asset carry them", async () => {
    const s = await serve();
    try {
      for (const p of ["/", "/cache/AC1234", "/assets/index-abc123.js", "/manifest.webmanifest"]) {
        const res = await fetch(`http://127.0.0.1:${s.port}${p}`);
        expect(res.status, p).toBe(200);
        expectPageHeaders(res, p);
      }
      const missing = await fetch(`http://127.0.0.1:${s.port}/assets/gone-000.js`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).not.toContain("text/html");
      // a 404 for a file a new build is still copying in must not be kept by a cache in front
      expect(missing.headers.get("cache-control")).toBe("no-store");
    } finally {
      await s.close();
    }
  });

  it("the gateway's own HTML pages carry them, and the embed widget keeps its own frame policy", async () => {
    const s = await serve();
    try {
      for (const p of ["/imprint", "/privacy", "/terms", "/sitemap", "/support"]) {
        const res = await fetch(`http://127.0.0.1:${s.port}${p}`, { headers: { accept: "text/html" } });
        expect(res.headers.get("content-type"), p).toContain("text/html");
        expectPageHeaders(res, p);
      }
      const embed = await fetch(`http://127.0.0.1:${s.port}/embed?bbox=14,46,16,48`);
      expect(embed.headers.get("content-security-policy")).toContain("frame-ancestors *");
      expect(embed.headers.get("x-frame-options")).toBeNull();
      // a JSON answer is not a page
      const health = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(health.headers.get("x-frame-options")).toBeNull();
    } finally {
      await s.close();
    }
  });
});
