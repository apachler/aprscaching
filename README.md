# aprscaching.com — reborn

An APRS-Caching-first web workbench. **M0→M6 are implemented:** the caching core +
verification engine, real-time geofencing, heritage imports, community/gamification, the APRS
workbench (full decoder, live station registry, packet inspector), and interop (CoT/TAK bridge,
multi-transport ingest, messaging), plus an open **federation** layer and a portable Node/SQLite
runtime.

**What works now:** hide a cache and log a find verified across trust tiers A (RF-corroborated),
B (in-app geolocation) and C (IS-only); live "you're near a cache" geofence prompts; import from
heritage programs (SOTA/POTA/WWFF/…); leaderboards, profiles and badges; decode any APRS frame
(MIC-E, compressed, objects/items/messages/weather/telemetry); a live stations map fed by APRS-IS,
KISS/TNC, TAK/CoT and Meshtastic; and a TAK feed + embeddable QRZ badge out. See `TODO.md` for the
tracked follow-ups.

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

## Compatibility

The platform runs in **three deployment shapes** and degrades gracefully across browsers. Nothing
here blocks the core (browse map, hide, log a find) — only the listed capabilities vary.

### Server deployment modes
| Capability | Cloudflare (edge) | Node + SQLite (self-host) | Ingest box |
|---|:--:|:--:|:--:|
| REST API + web app | ✅ Workers + Pages | ✅ `servers/node` (better-sqlite3) | — |
| Live WebSocket (stations/geofence) | ✅ Durable Object (hibernation) | ✅ in-memory rooms | — |
| Verification engine (tiers A/B/C) | ✅ | ✅ | — |
| Federation (signed feeds, mirror, corroborate) | ✅ | ✅ | — |
| Heritage imports (SOTA/POTA/…) | ✅ | ✅ (needs egress) | — |
| CoT/TAK bridge out · ports · messaging | ✅ | ✅ | — |
| Media / audio-cache (R2) | ✅ R2 binding | ⏳ S3/FS adapter (planned) | — |
| APRS-IS firehose ingest | via box | via box | ✅ |
| KISS/TNC · TAK/CoT in · Meshtastic | — | — | ✅ Node only (`apps/ingest`) |
| APRS-IS TX / announce uplink | via box | via box | ✅ (gated, opt-in) |

Conformance is proven identical on **Cloudflare Worker** and **Node/SQLite** by the same smoke
suite running against both in CI.

### Browser support (web app)
| Feature | Chrome/Edge | Firefox | Safari | Notes |
|---|:--:|:--:|:--:|---|
| Map + markers (MapLibre/WebGL) | ✅ | ✅ | ✅ | WebGL1 fallback on old GPUs |
| Live updates (WebSocket) | ✅ | ✅ | ✅ | — |
| In-app geolocation (Tier B) | ✅ | ✅ | ✅ | needs HTTPS + user permission |
| Locale & units (Intl) | ✅ | ✅ | ✅ | derives from browser, overridable |
| Copy TAK/CoT URL (Clipboard) | ✅ | ✅ | ✅ | secure context only |
| Passkey sign-in (WebAuthn) | ✅ | ✅ | ✅ | platform authenticator |
| **Per-callsign signing (WebCrypto Ed25519)** | ✅ 137+ | ✅ 129+ | ✅ 17+ | older browsers log finds **unsigned** (still tier A/B); no breakage |
| Embeddable badge `<img>` SVG | ✅ | ✅ | ✅ | renders anywhere, incl. QRZ.com |

Mobile Chrome/Safari track their desktop engines. The one capability gated on a *recent* browser is
the Ed25519 device-key signature (F0); everywhere else the app falls back cleanly to unsigned logging.

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

## Interop (M6) — TAK bridge, transports, messaging

Headroom toward the wider workbench: bridge APRS out to **TAK** and account for **multiple
transports**. `GET /api/cot?bbox=` renders the live station registry as a Cursor-on-Target
`<events>` snapshot — paste the URL into ATAK/WinTAK as a data feed and APRS stations show up as CoT
(symbol → CoT type, knots → m/s, altitude → HAE). Ingest tallies **RX per transport** (`aprs-is`,
`kiss-tnc`, `meshtastic`, …) surfaced at `GET /api/ports`, and decoded inbound **messages/bulletins**
are at `GET /api/messages`. The 📡 Workbench panel shows connected transports, the TAK feed URL, and
recent messages.

The ingest box now speaks **multiple transports** (each forwards to `/ingest` on its own `port`):
APRS-IS, **KISS/TNC** over TCP (Direwolf), **TAK/CoT** inbound (UDP), and **Meshtastic** (JSON over
TCP). Enable them in `.env` (`KISS_TNC_HOST`, `TAK_COT_PORT`, `MESH_HOST`). The AX.25/KISS, CoT and
Meshtastic codecs live in `@aprsweb/aprs` (tested). Message **TX** and native MQTT/BLE/serial remain
follow-ups (`TODO.md`).

With a KISS TNC the box can also be a real RF citizen (opt-in, TX off by default):
- **Digipeater** (`DIGI_CALL`): new n-N paradigm — insert our call (H-bit), decrement `WIDEn-N`,
  loop-guard + duplicate suppression.
- **APRS IGate** (`IGATE_CALL` + `IGATE_PASS`): RX-IGate relays RF → APRS-IS with a `qAR` construct;
  TX-IGate gates IS messages → RF for locally-heard stations, honouring NOGATE/RFONLY/TCPIP +
  third-party rules.
The gating/path logic is pure + unit-tested in `@aprsweb/aprs` (`digipeat.ts`, `igate.ts`).

An operator's standing is also exportable as an **embeddable SVG badge** for QRZ.com / signatures:
`<img src="https://api.aprscaching.com/badge/OE8APR.svg">` (network rank · finds · points · hides).

```bash
curl "$API/api/cot?bbox=15,46,16,48"   # CoT/TAK snapshot for ATAK
curl "$API/api/ports"                  # 24h RX/TX per transport
curl "$API/api/messages?bulletins=1"   # recent bulletins
curl "$API/badge/OE8APR.svg"           # embeddable network badge
```

## Accounts & data lifecycle (GDPR / DSGVO)

Sensitive account actions are authorised by a signature from a device key already registered to the
callsign (or a matching passkey session) — no central password to leak.

```bash
# all signed POSTs carry { key, sig, at } over accountActionMessage(action, callsign, instance, at)
POST /api/account/:callsign/export   # full machine-readable copy of your data (right of access)
POST /api/account/:callsign/delete   # erase: anonymise finds, drop PII/keys/account (right to erasure)
POST /api/account/:callsign/bundle   # portable bundle (device keys + verified state) for migration
POST /api/account/:callsign/move     # mark this callsign moved to another instance
POST /api/account/import             # claim the callsign on a new instance (verifies the bundle)
```

Export + erase are in the web app under **⚙ Settings → Your data**. Because finds are per-callsign
**device-signed**, your history stays attributable even after you move instances. Positions are
TTL'd; the schema stores public ham identifiers (callsigns) and APRS positions that are public by
design on RF/APRS-IS. (Federation tombstone propagation + an instance-signed bundle are tracked
follow-ups.)

## Verification at a glance
| Tier | Means | How |
|------|-------|-----|
| A | RF-corroborated | heard on RF (`qAR`), gated by an IGate that isn't yours, plausible track |
| B | App-corroborated | first-party in-app device geolocation matches the cache |
| C | IS-only | bare APRS-IS beacon — logged but unverified |

Minimum accepted tier is configurable (site default **B**; per-cache override). A bare IS
packet can't reach tier B on its own — corroboration must come from the app reading.
