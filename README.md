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

## Federation (F1) — open, mirrorable, signed

Any instance (Cloudflare *or* the Node self-host) publishes read-only, Ed25519-signed feeds so
peers can mirror it into a shared catalog (see `docs/06-federation-and-open-network.md`):

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/aprscaching` | instance descriptor: protocol, public key, peers, capabilities |
| `GET /federation/caches?since=<updated_at>` | signed cache records (idempotent by namespaced id) |
| `GET /federation/finds?since=<id>` | signed find records (append-only cursor) |
| `GET /federation/peers` | configured peers + per-feed cursors and sync status |
| `POST /federation/sync` | trigger a pull from all peers (auth: `x-ingest-secret`) |

Enable signing by generating a key and setting it as a secret (else feeds serve unsigned):

```bash
node tools/fedkey/genkey.mjs            # prints FED_PRIVATE_KEY (+ the public key it will publish)
# Cloudflare:  wrangler secret put FED_PRIVATE_KEY      (and set INSTANCE in wrangler.toml)
# Node:        export FED_PRIVATE_KEY=... INSTANCE=oe.aprscaching.org
```

**Mirroring (F2).** Point an instance at peers with `FED_PEERS=https://a.example,https://b.example`.
It pulls their feeds on a schedule (cron / 5-min interval), **verifies each record's signature**
against the peer's published key, and mirrors them locally — peer caches then appear on your map
(dashed pin, read-only) alongside your own. `tools/smoke/federation.mjs` proves the full
publisher→subscriber loop and runs in CI across two instances.

## Verification at a glance
| Tier | Means | How |
|------|-------|-----|
| A | RF-corroborated | heard on RF (`qAR`), gated by an IGate that isn't yours, plausible track |
| B | App-corroborated | first-party in-app device geolocation matches the cache |
| C | IS-only | bare APRS-IS beacon — logged but unverified |

Minimum accepted tier is configurable (site default **B**; per-cache override). A bare IS
packet can't reach tier B on its own — corroboration must come from the app reading.
