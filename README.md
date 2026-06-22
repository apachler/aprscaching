# aprscaching.com — reborn

An APRS-Caching-first web workbench. This is the **M0 scaffold** (Phase 0): monorepo,
Cloudflare bindings, D1 schema, pure APRS parser, the **verification engine**, the ingest
client, and a placeholder web app. It is a skeleton — run `pnpm install`, then build out the
milestones in `PLAN` / `CLAUDE.md`.

## Layout
- `packages/aprs` — pure parser: TNC2, q-construct (RF vs injected), position, geo. **Tested.**
- `packages/shared` — zod contracts (Packet, WS messages, DTOs).
- `workers/gateway` — Cloudflare Worker: `/ingest`, `/api/caches`, `/api/logs/find`, `/ws`
  (Durable Object `RegionRoom`, hibernating). **`src/verify.ts` is the trust-tier engine.**
- `apps/ingest` — always-on APRS-IS → batched POST forwarder (Fly/Railway/Pi).
- `apps/web` — React + MapLibre SPA → Cloudflare Pages (placeholder until M1).
- `db/migrations/0001_init.sql` — caches, cache_logs, positions, accounts, +workbench tables.

## Quick start
```bash
pnpm install
pnpm --filter @aprsweb/aprs test          # the parser + q-construct tests pass

# Cloudflare side
cd workers/gateway
wrangler d1 create aprscaching             # paste database_id into wrangler.toml
wrangler d1 migrations apply aprscaching --local
wrangler dev                               # serves /health, /ingest, /api/*, /ws

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
