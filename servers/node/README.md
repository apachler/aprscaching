# @aprscaching/node-gateway — portable self-host runtime

The aprscaching gateway running on **Node + SQLite**. It serves the runtime-neutral gateway app
(`workers/gateway`, imported as `@aprscaching/gateway/app`) and supplies the interfaces the app is written
against (`workers/gateway/src/runtime.ts`); the Bun server (`servers/bun`) reuses these host modules:

| Interface | Node (here) |
|---|---|
| DB | SQLite (better-sqlite3) behind the app's `SqlDatabase` interface (`d1.ts`) |
| Real-time | in-memory region rooms over `ws` (`rooms.ts`, on the shared `rooms-core.ts`) |
| HTTP | `node:http` (and optionally `node:https`) ↔ Web `Request`/`Response` bridge (`listen.ts`) |
| Media | the filesystem (`media.ts`, `MEDIA_DIR`) |
| Scheduled jobs | `setInterval`: the nightly jobs (`runScheduled`), and the frequent federation sync (`runFrequentSync`, every `FED_SYNC_INTERVAL_MS`, default 5 min) |

This is the **self-host story** for hams and clubs who want to run their own node and join the
federated network (see [Federation](../../docs/run/federation/index.md)) instead of standing up an island.

## Run it

```bash
# from the repo root
pnpm install
pnpm --filter @aprscaching/node-gateway start         # http://127.0.0.1:8787  (creates ./data/aprscaching.db)
```

Or with Docker (build from the repo root):

```bash
docker build -f servers/node/Dockerfile -t aprscaching-node .
docker run -p 8787:8787 -v aprscaching-data:/data -e INGEST_SECRET=$(openssl rand -hex 24) aprscaching-node
```

For development, `pnpm dev` at the repo root runs it with the web app on one origin, restarting on every edit.
`pnpm dev:web` alone proxies the gateway's paths to it on `http://127.0.0.1:8787`.
Point the ingest box at it: `INGEST_URL=http://127.0.0.1:8787/ingest` in `.env`.

## Configuration

| env | default | meaning |
|-----|---------|---------|
| `PORT` | `8787` | HTTP + WS port |
| `DB_PATH` | `./data/aprscaching.db` | SQLite file (WAL mode) |
| `MIGRATIONS_DIR` | `../../db/migrations` | the shared schema |
| `INGEST_SECRET` | *(required)* | bearer for `/ingest`, `/outbox` — the server refuses to boot when unset or `change-me` |
| `MEDIA_DIR` | `./data/media` | uploaded cache media |
| `WEB_DIST` | *(unset)* | the built SPA (`apps/web/dist`): set, the server serves it on the same origin as the API, so no reverse proxy is needed, and sends its text assets brotli- or gzip-compressed to a browser that accepts it; unset, it serves only the API (Caddy serves the SPA in the Docker stack) |
| `HTTPS_PORT` | *(unset)* | an https listener beside `PORT`, with the same API, SPA and `/ws`; request-derived links say `https`. The plain port then redirects other devices' page loads there (never loopback, API, ingest or federation calls). Needs `TLS_CERT` + `TLS_KEY` or the server refuses to boot |
| `TLS_CERT` / `TLS_KEY` | *(unset)* | PEM certificate (with chain) and key for `HTTPS_PORT`; `kill -HUP <pid>` of the node process reloads them without a restart |
| `TLS_CA_CERT` | *(unset)* | a CA certificate served read-only at `/pocket-ca.crt` on both ports, for visitors to install |

The https listener is for a station its visitors reach on its own Wi-Fi hotspot, with no proxy in front
([Visitors on the hotspot](../../docs/run/day-to-day/sign-in-links.md#visitors-on-the-hotspot)); behind Caddy or a
tunnel, leave it off and let the proxy terminate TLS. Every setting is in the
[configuration reference](../../docs/reference/configuration.md).

Migrations are applied automatically on boot and tracked in a `_migrations` table.

## Conformance

`tools/smoke/smoke.mjs` runs an assertive end-to-end flow (hide → list → Tier A/B/C → DNF →
owner-gating → auth guards). CI runs it against this server and the Bun server, so the
two runtimes can never silently diverge.

## Scope / notes
- Single-process SQLite ⇒ single node. Another database would plug in behind the same `SqlDatabase` shim.
- WebSockets stay open in the one process, which is always up.
- The offline map archive is a file (`OFFLINE_TILES_PATH`), served by byte range at `/tiles/offline.pmtiles`.
