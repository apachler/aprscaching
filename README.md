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
| `POST /federation/corroborate` | answer a peer: was a callsign heard on RF near here, independently? (F3) |
| `GET /federation/keys?since=<id>` | signed feed of callsign→device-key bindings (F0) |
| `POST /keys/register` · `GET /keys/:callsign` | register / list a callsign's device public keys (F0) |

Enable signing by generating a key and setting it as a secret (else feeds serve unsigned):

```bash
node tools/fedkey/genkey.mjs            # prints FED_PRIVATE_KEY (+ the public key it will publish)
# Cloudflare:  wrangler secret put FED_PRIVATE_KEY      (and set INSTANCE in wrangler.toml)
# Node:        export FED_PRIVATE_KEY=... INSTANCE=oe.aprscaching.org
```

**Mirroring (F2).** Point an instance at peers with `FED_PEERS=https://a.example,https://b.example`.
It pulls their feeds on a schedule (cron / 5-min interval), **verifies each record's signature**
against the peer's published key, and mirrors them locally — peer caches then appear on your map
(dashed pin, read-only) alongside your own. Peers are listed manually in `FED_PEERS`; set
**`FED_DISCOVER=1`** to also auto-adopt the peers each peer advertises (transitive discovery).

**Per-callsign signing (F0).** Each user holds an Ed25519 keypair in their browser and registers
the public key to their callsign. Find logs are **signed on-device**, so authorship is
cryptographically attributable to a callsign and verifiable by anyone — the feeds carry the
signature, and the callsign→key bindings are published as their own signed feed (mirrored by peers).
The web signs transparently; a browser without Ed25519 just logs unsigned.

**Cross-instance verification (F3) — the network effect.** RF-heard positions are public, so when a
find can't reach Tier A locally, the instance asks its peers *"did you independently hear this
callsign on RF near the cache, gated by an IGate that isn't theirs?"* A hit upgrades the find to
**Tier A** (`method: aprs_rf_peer`, attributed to the corroborating instance). The more instances
and IGates participate, the more finds verify — like iNaturalist's "more observers ⇒ better data".
`tools/smoke/federation.mjs` proves the whole publisher→subscriber loop (mirror + corroboration)
and runs in CI across two instances.

## Imports (M3) — heritage sources, kept fresh

Pull third-party location programs into your map. Each imported cache shows a **source disclaimer
+ deep link**, re-importing **updates in place** (dedup on `source`+`external_id`), and imports are
**de-duplicated across sources** with ham-radio priority (a SOTA summit suppresses a coincident OSM
peak). Imported caches stay **local** (never published to `/federation`).

```bash
# admin-only (x-ingest-secret). Body = scope JSON.
curl -XPOST $API/api/import/sota   -H x-ingest-secret:$S -d '{"region":"GM/SI"}'     # SOTA summits by region
curl -XPOST $API/api/import/pota   -H x-ingest-secret:$S -d '{"region":"US-NY"}'     # POTA parks by location
curl -XPOST $API/api/import/wwff   -H x-ingest-secret:$S -d '{"region":"DLFF"}'      # WWFF by program prefix
curl -XPOST $API/api/import/bunker -H x-ingest-secret:$S -d '{"bbox":[13,46,17,49]}' # WWBOTA/UKBOTA by bbox
curl -XPOST $API/api/import/gcau   -H x-ingest-secret:$S -d '{"region":"vic"}'       # Geocaching Australia
curl -XPOST $API/api/import/osm    -H x-ingest-secret:$S -d '{"region":"natural=peak","bbox":[13,46,17,49],"type":"traditional"}'
curl -XPOST $API/api/import/wikidata -H x-ingest-secret:$S -d '{"region":"Q23413","type":"castle"}'  # castles (CC0)
curl -XPOST $API/api/import/iota   -H x-ingest-secret:$S -d '{"region":"EU"}'        # IOTA (non-commercial use)
# OpenCaching: each node (.de/.pl/.us/.nl/.ro/opencache.uk) is a SEPARATE database + key —
# import each node with its own {url,key} (or set OKAPI_BASE + OKAPI_KEY for one):
curl -XPOST $API/api/import/opencaching -H x-ingest-secret:$S \
  -d '{"url":"https://www.opencaching.de","key":"YOUR_DE_KEY","bbox":[13,46,17,49]}'
# WCA / any GeoJSON via the generic adapter:
curl -XPOST $API/api/import/geojson -H x-ingest-secret:$S \
  -d '{"url":"https://…/wca.geojson","source":"castle","type":"castle","sourceName":"WCA","deepLink":"https://www.cqgma.org/zinfo.php?ref={ref}"}'
```

**Tip:** import the highest-priority (ham) sources first so lower-priority POI imports de-dupe against
them. Licensing varies by source — OSM is ODbL share-alike, Wikidata is CC0, IOTA is non-commercial;
attribute appropriately. (See `docs/` and the source disclaimers shown in-app.)

## Workbench (M5) — APRS depth

APRS Caching rides on a real APRS workbench. The `@aprsweb/aprs` decoder turns raw frames into
typed data — uncompressed / **base-91 compressed** / **MIC-E** positions (course, speed, altitude,
ambiguity), **objects/items**, **messages** (incl. acks & bulletins), **status**, **weather**, and
**telemetry**, each resolved to a symbol label + category. Ingested packets enrich a live **station
registry** (`stations`), weather lands in `sensor_readings`, and text in `messages`.

```bash
# decode any raw TNC2 / APRS-IS line (the in-app inspector uses this)
curl -XPOST $API/api/decode -d '{"raw":"OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.41N/01526.27E>088/036/A=001234Mobile"}'
curl "$API/api/stations?bbox=15,46,16,48"   # live stations in a viewport
curl "$API/api/stations/OE8APR-9"           # one station: track + latest wx + packet count
```

In the web app the **📡 Workbench** panel toggles a live stations layer (moving stations show a
heading arrow), decodes pasted packets field-by-field, and inspects any station (symbol, speed/course,
altitude, weather, recent track).

## Verification at a glance
| Tier | Means | How |
|------|-------|-----|
| A | RF-corroborated | heard on RF (`qAR`), gated by an IGate that isn't yours, plausible track |
| B | App-corroborated | first-party in-app device geolocation matches the cache |
| C | IS-only | bare APRS-IS beacon — logged but unverified |

Minimum accepted tier is configurable (site default **B**; per-cache override). A bare IS
packet can't reach tier B on its own — corroboration must come from the app reading.
