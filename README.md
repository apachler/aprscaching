# aprscaching.com — reborn

An APRS-Caching-first web workbench. **M0 scaffold + M1 caching core are implemented:**
monorepo, Cloudflare bindings, D1 schema, pure APRS parser, the **verification engine**
(tested), the ingest client, and a real cache-first web app.

**M1 — what works now:** hide a cache on the map, see it rendered by type/D/T, open its
detail + logbook, and log a find (found/DNF/note) that the engine verifies across trust
tiers A (RF-corroborated), B (in-app geolocation) and C (IS-only). Next up is M2
(real-time geofence prompts) — see `PLAN.md`.

## Layout
- `packages/aprs` — pure parser: TNC2, q-construct (RF vs injected), position, geo. **Tested.**
- `packages/shared` — zod contracts (Packet, WS messages, DTOs).
- `workers/gateway` — Cloudflare Worker: `/ingest`, `/api/caches`, `/api/logs/find`, `/ws`
  (Durable Object `RegionRoom`, hibernating). **`src/verify.ts` is the trust-tier engine.**
- `apps/ingest` — always-on APRS-IS → batched POST forwarder (Fly/Railway/Pi).
- `apps/web` — React + MapLibre SPA → Cloudflare Pages. Map, hide-a-cache, detail+logbook, logging.
- `db/migrations/0001_init.sql` — caches, cache_logs, positions, accounts, +workbench tables.
  Spatial lookups use a plain lat/lon index (D1 forbids rtree virtual tables).

## Quick start
```bash
pnpm install
pnpm --filter @aprsweb/aprs test           # parser + q-construct tests
pnpm --filter @aprsweb/gateway test        # verification-engine tests

# Cloudflare side
cd workers/gateway
wrangler d1 create aprscaching             # paste database_id into wrangler.toml (remote)
wrangler d1 migrations apply aprscaching --local   # migrations_dir -> ../../db/migrations
wrangler dev                               # serves /health, /ingest, /api/*, /ws

# Web app (new shell) — VITE_API_BASE defaults to http://127.0.0.1:8787
pnpm --filter @aprsweb/web dev             # map UI: hide a cache, log a find

# Ingest box (new shell)
cp .env.example .env                       # set APRSIS_FILTER + INGEST_SECRET
pnpm --filter @aprsweb/ingest dev          # streams APRS-IS -> POST /ingest
```

## Verification at a glance
| Tier | Means | How |
|------|-------|-----|
| A | RF-corroborated | heard on RF (`qAR`), gated by an IGate that isn't yours, plausible track |
| B | App-corroborated | first-party in-app device geolocation matches the cache |
| C | IS-only | bare APRS-IS beacon — logged but unverified |

Minimum accepted tier is configurable (site default **B**; per-cache override). A bare IS
packet can't reach tier B on its own — corroboration must come from the app reading.
