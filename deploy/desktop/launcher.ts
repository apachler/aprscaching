#!/usr/bin/env bun
/**
 * aprscaching desktop launcher — the single-binary, all-in-one Topology 0 entry (gateway + SPA).
 * Compiled with `bun build --compile` (see build-exe.sh): one file that starts a local server,
 * serves the embedded SPA, keeps SQLite in the OS app-data dir, and opens the browser. RF comes from
 * the **browser (Web Serial/BLE)** — operator-local, per .claude/rules/ingest-locality.md; an
 * always-on local ingest is run separately (apps/ingest) when wanted. Off-grid by default.
 *
 * Assets (SPA + migrations) are embedded via assets.generated.ts when compiled; in dev (plain
 * `bun run launcher.ts`) it falls back to reading apps/web/dist + db/migrations from disk.
 */
import { mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appDataDir } from "./appdata.ts";
import { BunDb } from "../../servers/bun/d1.ts";
import { makeFsMedia } from "../../servers/bun/media.ts";
import { BunRooms, type WsData } from "../../servers/bun/rooms.ts";
import { handle, runScheduled, type Env, type LiveEnvelope } from "../../servers/bun/gateway.ts";

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";
const PORT = Number(process.env.PORT ?? 8787);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- assets: embedded (compiled) or disk (dev) ----
let SPA: Record<string, string> = {};
let MIGRATIONS: { name: string; sql: string }[] = [];
try {
  const gen = (await import("./assets.generated.ts")) as {
    SPA?: Record<string, string>;
    MIGRATIONS?: { name: string; file: string }[];
  };
  SPA = gen.SPA ?? {};
  MIGRATIONS = await Promise.all(
    (gen.MIGRATIONS ?? []).map(async (m) => ({ name: m.name, sql: await Bun.file(m.file).text() })),
  );
} catch {
  /* dev: no embed manifest → fall back to disk below */
}

const embedded = Object.keys(SPA).length > 0;
const WEB_DIST = process.env.WEB_DIST ?? join(HERE, "../../apps/web/dist");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(HERE, "../../db/migrations");
if (MIGRATIONS.length === 0 && existsSync(MIGRATIONS_DIR)) {
  MIGRATIONS = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));
}

// ---- storage (app-data dir) ----
const dir = process.env.DATA_DIR ?? appDataDir("aprscaching");
mkdirSync(dir, { recursive: true });
const db = new BunDb(join(dir, "aprscaching.db"));
db.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
const applied = new Set((db.raw.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
let ran = 0;
for (const m of MIGRATIONS) {
  if (applied.has(m.name)) continue;
  db.raw.transaction(() => {
    db.raw.exec(m.sql);
    db.raw.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(m.name, Math.floor(Date.now() / 1000));
  })();
  ran++;
}

// ---- env (runtime-neutral bindings; same shape as servers/bun + servers/node) ----
const rooms = new BunRooms();
const env: Env = {
  DB: db,
  TILES: {},
  MEDIA: makeFsMedia(join(dir, "media")),
  ROOMS: {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (req: Request) => {
        if (req.method === "POST") {
          const { envelopes } = (await req.json()) as { envelopes: LiveEnvelope[] };
          rooms.dispatch(String(id), envelopes);
          return new Response(null, { status: 204 });
        }
        return new Response("expected websocket upgrade", { status: 426 });
      },
    }),
  },
  INGEST_SECRET: process.env.INGEST_SECRET ?? "local-desktop",
  INSTANCE: process.env.INSTANCE,
  FED_PRIVATE_KEY: process.env.FED_PRIVATE_KEY,
  FED_PEERS: process.env.FED_PEERS,
  FED_DISCOVER: process.env.FED_DISCOVER,
  // AGPL §13 source link: the build stamps BUILD_VERSION (git describe) as the commit/tag.
  SOURCE_REPO: process.env.SOURCE_REPO,
  SOURCE_COMMIT: process.env.SOURCE_COMMIT ?? (VERSION !== "dev" ? VERSION : undefined),
};

// ---- SPA serving ----
const CT: Record<string, string> = {
  html: "text/html; charset=utf-8",
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
  txt: "text/plain",
  pmtiles: "application/octet-stream",
  wasm: "application/wasm",
};
const ctOf = (p: string) => CT[p.slice(p.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

function serveSpa(pathname: string): Response {
  const p = pathname === "/" ? "/index.html" : pathname;
  if (embedded) {
    const file = SPA[p] ?? SPA["/index.html"]; // SPA-router fallback
    return new Response(Bun.file(file), { headers: { "content-type": ctOf(SPA[p] ? p : "/index.html") } });
  }
  const fp = join(WEB_DIST, p.replace(/^\/+/, ""));
  if (!fp.startsWith(WEB_DIST)) return new Response("bad path", { status: 400 });
  if (existsSync(fp)) return new Response(Bun.file(fp), { headers: { "content-type": ctOf(fp) } });
  return new Response(Bun.file(join(WEB_DIST, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// gateway (dynamic) paths go to handle(); everything else is the SPA.
const DYNAMIC = /^\/(api|auth|verify|keys|ingest|outbox|federation|badge|health|source|\.well-known)(\/|$|\?)/;

const server = Bun.serve<WsData, undefined>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const region = url.searchParams.get("region") ?? "global";
      if (srv.upgrade(req, { data: { region } })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    if (DYNAMIC.test(url.pathname))
      return handle(req, env, { waitUntil: (p) => void Promise.resolve(p).catch(() => {}) });
    return serveSpa(url.pathname);
  },
  websocket: {
    open(ws) {
      rooms.join(ws);
    },
    message(ws, msg) {
      rooms.onMessage(ws, msg);
    },
    close(ws) {
      rooms.leave(ws);
    },
  },
});

const localUrl = `http://localhost:${server.port}`;
console.log(
  `aprscaching ${VERSION} → ${localUrl}   (data: ${dir}${ran ? `, ${ran} migrations applied` : ""}${embedded ? ", embedded assets" : ", disk assets"})`,
);
openBrowser(localUrl);

setInterval(() => void runScheduled(env).catch((e) => console.error("scheduled:", e)), 24 * 3600 * 1000);

function openBrowser(u: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", u]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", u]
        : ["xdg-open", u];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* headless: ignore */
  }
}
