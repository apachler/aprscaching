# @aprscaching/node-gateway — portable self-host runtime

The aprscaching gateway running on **Node + SQLite**, with **no Cloudflare dependency**. It serves
the *exact same* API and business logic as the Cloudflare Worker (`workers/gateway`) — the handlers
are shared (`@aprscaching/gateway/app`); only the bindings differ:

| Binding | Cloudflare | Node (here) |
|---|---|---|
| DB | D1 | SQLite (better-sqlite3) via a D1-compatible shim (`d1.ts`) |
| Real-time | Durable Object `RegionRoom` | in-memory region rooms over `ws` (`rooms.ts`) |
| HTTP | Workers runtime | `node:http` ↔ Web `Request`/`Response` bridge (`server.ts`) |
| Cron | `scheduled()` | `setInterval` nightly TTL |

This is the **self-host story** for hams and clubs who want to run their own node and join the
federated network (see ``) instead of standing up an island.

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

Point the web app at it: `VITE_API_BASE=http://127.0.0.1:8787 pnpm --filter @aprscaching/web dev`.
Point the ingest box at it: `INGEST_URL=http://127.0.0.1:8787/ingest` in `.env`.

## Configuration

| env | default | meaning |
|-----|---------|---------|
| `PORT` | `8787` | HTTP + WS port |
| `DB_PATH` | `./data/aprscaching.db` | SQLite file (WAL mode) |
| `MIGRATIONS_DIR` | `../../db/migrations` | the shared schema (same files D1 uses) |
| `INGEST_SECRET` | *(required)* | bearer for `/ingest`, `/outbox` — the server refuses to boot when unset or `change-me` |

Migrations are applied automatically on boot and tracked in a `_migrations` table.

## Conformance

`tools/smoke/smoke.mjs` runs an assertive end-to-end flow (hide → list → Tier A/B/C → DNF →
owner-gating → auth guards). CI runs it against **both** this server and `wrangler dev`, so the two
runtimes can never silently diverge.

## Scope / notes
- Single-process SQLite ⇒ single node. Horizontal scale (libSQL/Turso or Postgres) can slot into the
  same `SqlDatabase` shim later.
- No WS hibernation (a self-host process is always up); the subscribe/broadcast semantics match the DO.
- R2 (`TILES`) is a stubbed reserved seam (instance-served offline tile packs).
