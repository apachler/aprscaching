#!/usr/bin/env bun
// aprscaching desktop launcher — single-binary, all-in-one (gateway + SPA + optional local ingest).
// Compiled with `bun build --compile` (see build-exe.sh). Runs a local server, opens the browser,
// and keeps SQLite in the OS app-data dir. RF comes from the browser (Web Serial/BLE) or the
// bundled ingest — operator-local, per .claude/rules/ingest-locality.md.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "./appdata";
import { BunD1 } from "./db-bun-sqlite";

// ── Wire these to the real repo exports (runtime-neutral, already used by servers/node) ──
// import { createGateway } from "../../workers/gateway/src/app";   // -> { fetch(req, env), websocket? }
// import { runMigrations } from "../../servers/node/src/migrate";  // applies db/migrations
// import { startIngest }  from "../../apps/ingest/src/index";      // optional local RF/IS ingest
// Embedded SPA (bun --compile embeds imported files). Point at your built dist:
// import indexHtml from "../../apps/web/dist/index.html" with { type: "file" };

declare const BUILD_VERSION: string;            // injected via --define
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";
const PORT = Number(process.env.PORT ?? 8080);

const dir = appDataDir("aprscaching");
mkdirSync(dir, { recursive: true });
const db = new BunD1(join(dir, "aprscaching.db"));
// await runMigrations(db);

// const gateway = createGateway();              // runtime-neutral handler
const server = Bun.serve({
  port: PORT,
  // websocket: gateway.websocket,               // wire in-memory rooms (same as servers/node)
  async fetch(req) {
    const url = new URL(req.url);
    const dynamic = /^\/(api|auth|ws|ingest|outbox|federation|\.well-known)(\/|$)/.test(url.pathname);
    if (dynamic) {
      // return gateway.fetch(req, { DB: db, /* R2/FS media adapter, env… */ });
      return new Response("gateway not wired (see TODO in launcher.ts)", { status: 501 });
    }
    // Serve embedded SPA; SPA-router fallback to index.html
    // return new Response(Bun.file(indexHtml), { headers: { "content-type": "text/html" } });
    return new Response("SPA not wired (see TODO in launcher.ts)", {
      status: 200, headers: { "content-type": "text/html" },
    });
  },
});

// Optional: start the operator-local ingest if configured (browser RF works regardless).
// if (process.env.APRSIS_CALLSIGN) {
//   startIngest({ INGEST_URL: `http://localhost:${server.port}/ingest`,
//                 INGEST_SECRET: process.env.INGEST_SECRET ?? "local",
//                 APRSIS_CALLSIGN: process.env.APRSIS_CALLSIGN, /* … */ });
// }

const localUrl = `http://localhost:${server.port}`;
console.log(`aprscaching ${VERSION} → ${localUrl}   (data: ${dir})`);
openBrowser(localUrl);

function openBrowser(u: string) {
  const cmd =
    process.platform === "darwin" ? ["open", u] :
    process.platform === "win32"  ? ["cmd", "/c", "start", "", u] :
                                    ["xdg-open", u];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch { /* headless: ignore */ }
}
