# APRSWeb — Cost-Optimized Implementation Plan (v2)

A clean-room, web-native reimplementation of the **APRStac** feature set, re-architected on
**Cloudflare** for near-zero idle cost. Built from open APRS specs (APRS101, APRS-IS,
AX.25/KISS, Meshtastic, TAK/CoT) — never from APRStac's closed-source binary, assets, or
branding.

> **Target:** lowest sustainable monthly bill at ~1000 active users without sacrificing the
> live-map experience. Floor is **~$0–3/mo** (hobby) and **~$9–13/mo** (recommended
> production), down from the ~$30–85/mo of the Netlify + Fly + Supabase design.

---

## 0. Why this stack is cheap (the cost thesis)

The bill on a realtime map app is normally dominated by three things: frontend egress,
always-on compute holding WebSockets, and a managed database. This architecture zeroes out
the first, nearly zeroes the second, and minimizes the third.

1. **Frontend egress → $0.** Cloudflare Pages serves the SPA with unlimited bandwidth; R2
   serves map tiles/files with **zero egress fees**. Netlify and Vercel both meter egress —
   this is the single biggest structural saving.
2. **Idle WebSockets → ~$0.** Durable Objects with the **Hibernation API** keep connections
   open while *not* accruing duration charges when idle. A map app is mostly idle viewers, so
   this is exactly the right billing model.
3. **Fan-out is the free direction.** DO WebSocket billing counts **incoming** client
   messages at a 20:1 ratio; **outgoing** messages (server→client) and protocol pings are
   **free**. Your APRS firehose → thousands of clients flows the *free* way. Clients send
   almost nothing (one subscribe + occasional viewport change).
4. **Database → $0 at this scale.** Use **Cloudflare D1** (serverless SQLite) with an
   **R\*Tree** index for "stations in viewport" queries, instead of managed Postgres/PostGIS.
   D1's free/included tiers cover a filtered feed. Neon stays an *optional* upgrade only if you
   later need true PostGIS or outgrow D1.
5. **One tiny always-on box** is the only irreducible fixed cost: the APRS-IS ingest singleton
   (~$2/mo on Fly, or **$0 self-hosted on a Raspberry Pi** — which also fits APRStac's ethos).

**The one thing you can't put on Cloudflare:** the persistent APRS-IS TCP connection. A
Durable Object's outbound `connect()` only pins it alive for **15 minutes max** per
connection, so an indefinitely-open feed fights the platform. Keep ingest on a real box.

---

## 1. Architecture (v2)

```
   Browser (SPA)                              ┌─────────────────────────────┐
   served by Cloudflare Pages (free)          │  APRS-IS (rotate.aprs2.net) │
   ┌───────────────────────────┐              └──────────────┬──────────────┘
   │ React + MapLibre + uPlot  │                             │ persistent TCP (filtered)
   │  • WebSocket client  ◄─────┼──────┐                      ▼
   │  • Web Serial / BLE        │      │       ┌──────────────────────────────────────┐
   │      (optional hardware)   │      │       │  INGEST  (tiny always-on container)   │
   └───────────┬───────────────┘      │       │  Fly $2/mo  ·  Railway  ·  or Pi $0    │
               │ HTTPS                 │  WS   │  • holds APRS-IS socket + parses       │
               ▼                       │       │  • BATCHES packets → POST to Worker    │
   ┌───────────────────────────┐      │       └───────────────────┬───────────────────┘
   │  Cloudflare Worker (edge) │      │                           │ HTTPS POST /ingest (batched, authed)
   │  • REST: snapshot/history │      │                           ▼
   │  • routes to Durable Obj  │──────┘       ┌──────────────────────────────────────┐
   │  • writes to D1           │◄─────────────┤  Durable Object(s)  "region rooms"    │
   └───────────┬───────────────┘              │  • hold client WebSockets (hibernate) │
               │                              │  • fan out deltas (OUTGOING = free)   │
               ▼                              └──────────────────────────────────────┘
   ┌───────────────────────────┐      ┌───────────────────────────┐
   │  D1 (SQLite + R*Tree)     │      │  R2 (PMTiles, fileshare)  │
   │  stations/sensors/msgs    │      │  zero egress              │
   └───────────────────────────┘      └───────────────────────────┘
```

**Flow:** ingest box is the only stateful always-on piece. It forwards parsed, *batched*
packets to a Worker. The Worker writes selectively to D1 and pushes updates into the relevant
**region Durable Object**, which fans them out to subscribed browsers over hibernatable
WebSockets. Reads (snapshot on connect, station history) are Worker→D1.

---

## 2. Tech stack

| Layer | Choice | Cost note |
|---|---|---|
| Frontend host | **Cloudflare Pages** | Free, unlimited bandwidth. |
| Map | **MapLibre GL + PMTiles on R2** | One static tile file; R2 egress is free. |
| Charts | **uPlot** | Tiny; no service cost. |
| Styling | **Tailwind CSS** | — |
| Client state | **TanStack Query + Zustand** | — |
| Edge API / routing | **Cloudflare Workers** | $5/mo Paid covers Workers+DO+D1+Cron. |
| Realtime fan-out | **Durable Objects (Hibernation API)** | Idle ≈ free; outgoing msgs free. |
| Database | **Cloudflare D1 (SQLite) + R\*Tree** | Free/included at this scale. |
| Object storage | **Cloudflare R2** | $0.015/GB, **no egress**. |
| **Ingest singleton** | **Node 20 + TS** (or Go) container on **Fly/Railway**, or **self-host on a Pi** | ~$2/mo, or $0 on a Pi. |
| APRS parsing | **`@aprsweb/aprs`** (own, pure, tested) | — |
| Monorepo | **pnpm workspaces** | — |

**Optional upgrade (only if needed):** swap D1 → **Neon** (serverless Postgres + PostGIS) if
you outgrow D1's write limits or need richer geo. Neon has a free tier; check current limits
before relying on it. Default stays D1 for cost.

---

## 3. Cost-reduction levers (apply these everywhere)

1. **Filter the APRS-IS feed server-side** (`r/lat/lon/dist`, `p/`, `b/`). Fewer packets =
   fewer D1 writes, fewer DO messages, less ingress work. This is the master volume dial.
2. **Persist selectively, not the firehose.** Upsert *latest station state*, downsampled
   sensor readings, and a *bounded* recent message/packet log — do **not** insert every raw
   frame. Each packet is only a few row-writes; selective persistence keeps D1 within free/
   included write limits.
3. **Batch ingest→Worker POSTs** (e.g. every 1–2 s or N packets). Fewer Worker invocations
   and fewer DO requests than per-packet calls.
4. **Lean on hibernation.** Use `state.acceptWebSocket()` (not `ws.accept()`) so idle map
   viewers cost no duration. Persist per-connection subscription state via
   `serializeAttachment` so hibernated sockets survive.
5. **Keep client→server chatter minimal.** Clients send one `subscribe {bbox, maxAge}` and
   only re-send on viewport change. Incoming messages bill 20:1; outgoing fan-out is free.
6. **TTL everything that grows.** Cron-trigger a nightly D1 cleanup: drop packets older than N
   days, roll up sensor history, cap the stations table (APRStac-style `max_stations`).
7. **Mind R2 Class A ops** ($4.50/M for writes/lists). Tiles are written once. For fileshare,
   batch and avoid chatty list calls. Reads (Class B) are cheap; egress is free.
8. **Self-host ingest if hobby.** A Raspberry Pi on home internet running the ingest forwarder
   drops the only fixed cloud cost to ~$0 and matches APRStac's off-grid spirit.
9. **No billing alerts on usage platforms** — add your own: a Worker cron that reads usage via
   GraphQL Analytics and pings you past a threshold.

---

## 4. Data model (D1 / SQLite)

```sql
-- latest state per station (hot path for map reads)
CREATE TABLE stations (
  callsign TEXT PRIMARY KEY,
  ssid INTEGER, symbol TEXT,
  lat REAL, lon REAL,
  last_seen INTEGER,                 -- epoch seconds
  course INTEGER, speed_kn INTEGER, altitude_m INTEGER,
  status_color TEXT,                 -- green|yellow|red (optional)
  comment TEXT
);

-- R*Tree spatial index → fast bounding-box "stations in viewport"
CREATE VIRTUAL TABLE station_rtree USING rtree(
  id,                                -- maps to rowid/callsign hash
  min_lat, max_lat, min_lon, max_lon
);

-- downsampled sensor history (NOT every reading)
CREATE TABLE sensor_readings (
  station TEXT, ts INTEGER,
  temp_c REAL, humidity REAL, pressure_hpa REAL,
  wind_dir INTEGER, wind_kn REAL, rain_mm REAL,
  PRIMARY KEY (station, ts)
);

-- bounded recent message log
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER,
  from_call TEXT, to_call TEXT, body TEXT, ack TEXT, direction TEXT
);

-- web-native BBS board
CREATE TABLE bbs_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, subject TEXT, body TEXT, ts INTEGER
);

-- optional: thin recent raw log for debugging, TTL'd hard
CREATE TABLE packets_recent (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER,
  src_call TEXT, kind TEXT, raw TEXT
);
```

> Geo query pattern: query `station_rtree` by bbox → join `stations` by id. Keep the R\*Tree
> rows in sync on every upsert. This replaces PostGIS at $0.

---

## 5. Repository structure

```
aprsweb/
├─ CLAUDE.md                     # conventions (see §10)
├─ PLAN.md                       # this file
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ web/                       # React SPA → Cloudflare Pages
│  │  └─ src/{map,panels,live,hardware,lib}
│  └─ ingest/                    # tiny always-on forwarder → Fly/Railway/Pi
│     ├─ src/{aprsis,parse,batch,forward}
│     ├─ Dockerfile
│     └─ fly.toml
├─ workers/
│  └─ gateway/                   # Cloudflare Worker + Durable Objects
│     ├─ src/{router,ingest,rooms,db,history}
│     ├─ wrangler.toml           # bindings: DO, D1, R2, cron
│     └─ migrations/             # D1 SQL migrations
└─ packages/
   ├─ aprs/                      # @aprsweb/aprs — pure parser/encoder + types
   └─ shared/                    # zod schemas, DTOs, WS message contracts
```

---

## 6. Implementation phases (Claude Code executes these)

### Phase 0 — Scaffold + accounts
**Tasks:** pnpm monorepo; Vite React app (`apps/web`); Worker project with `wrangler`
(`workers/gateway`); ingest service (`apps/ingest`); `@aprsweb/aprs` + `shared`; Cloudflare
account, Pages project, R2 bucket, D1 database created via `wrangler`.
**Acceptance:** `pnpm -r build` passes; `wrangler dev` serves a `/health` Worker route;
blank map renders from Pages dev.

### Phase 1 — `@aprsweb/aprs` parser (test-first, pure)
**Tasks:** parse TNC2 frames — position (compressed + uncompressed), MIC-E, weather, message
+ack, status, object/item, telemetry; encode outbound messages; Maidenhead/MGRS helpers.
**Acceptance:** Vitest corpus of real sample frames per type passes; message encode/decode
round-trips. No network, no platform deps (so it runs in Worker, Node, and browser).

### Phase 2 — Ingest forwarder (the only always-on box)
**Tasks:** APRS-IS client (login, **server-side filter**, reconnect/backoff, keepalive);
parse with `@aprsweb/aprs`; **batch** packets; authed `POST /ingest` to the Worker. Keep it
tiny and stateless beyond the socket.
**Acceptance:** Pointed at a live filtered feed, batched POSTs arrive at a local `wrangler dev`
Worker; survives a forced socket drop; respects the configured filter (volume stays bounded).

### Phase 3 — Worker ingest + D1 writes + DO routing
**Tasks:** `/ingest` endpoint (verify shared secret); **selective** D1 upserts (station +
R\*Tree, downsampled sensors, bounded message/packet log); route each update to the correct
**region Durable Object** by geo bucket.
**Acceptance:** Posting a batch updates D1; the matching DO receives the delta; D1 write count
per batch is minimized (verified in logs).

### Phase 4 — Durable Object fan-out (hibernation)
**Tasks:** DO holds client WebSockets via `acceptWebSocket()`; `subscribe {bbox, maxAge}`
stored with `serializeAttachment`; broadcast only matching deltas (outgoing = free); auto-pong.
**Acceptance:** Two browsers in different bboxes get only their stations; idle connections show
**no duration charges** in DO metrics; reconnect restores subscription.

### Phase 5 — Web app: live map
**Tasks:** MapLibre + PMTiles (from R2); station layer with APRS symbols, heading arrows, age
ghosting; Maidenhead grid + MGRS overlays; viewport-driven WS subscribe; snapshot-then-patch
(REST snapshot from Worker/D1, then live deltas).
**Acceptance:** Live map shows real stations; pan/zoom re-subscribes; 5k markers stay smooth.

### Phase 6 — Station detail, messages, weather
**Tasks:** detail panel; message inbox/thread; uPlot sensor charts with range selector (history
from D1 via Worker).
**Acceptance:** Selecting a station shows history; weather stations chart multi-series; messages
render correctly.

### Phase 7 — Auth + profile (lightweight)
**Tasks:** Cloudflare Access **or** a minimal Workers + signed-cookie/JWT auth; profile stores
callsign + default filter; per-user saved views. (Avoid a paid auth vendor to hold cost.)
**Acceptance:** Sign in/out; profile persists in D1; receive-only works with no passcode.

### Phase 8 — Cron cleanup + cost guardrails
**Tasks:** Worker Cron Trigger: nightly D1 TTL (drop old packets, roll up sensors, cap
stations); usage-watch cron that reads Analytics and alerts past a threshold.
**Acceptance:** Old rows are pruned on schedule; an alert fires in a forced over-threshold test.

### Phase 9 — Transmit over APRS-IS (gated) ⚠️ regulatory
**Tasks:** outbound messaging via the user's own callsign+passcode through the ingest box's
authenticated APRS-IS session; ack/retransmit; UI gates clearly on "licensed only."
**Acceptance:** A licensed tester sends/receives end-to-end; unlicensed users blocked in UI and
server-side. (Receive-only Phases 0–8 carry none of this risk — see note below.)

### Phase 10 — Local hardware via Web Serial / BLE (stretch)
**Tasks:** Web Serial KISS TNC + Web Bluetooth Meshtastic from the browser; feed local frames
into the same map and optionally up to the Worker. Chromium-only, HTTPS, user-grant.
**Acceptance:** With a KISS TNC attached, locally-heard stations appear without the cloud feed.

---

## 7. ⚠️ Regulatory note

Receiving/displaying APRS-IS data needs no license. **Transmitting** (messaging, IGate to RF)
requires the operator's own valid callsign + passcode and is subject to local rules (e.g. FCC
Part 97 in the US). Keep transmit **off by default**, gate it behind a verified callsign, and
never ship a shared/hard-coded passcode. Everything through Phase 8 is receive-only.

---

## 8. Cost estimate (cost-optimized)

**Assumptions:** ~1000 monthly actives, ~100–200 peak concurrent, a *filtered* regional
APRS-IS feed, selective persistence, PMTiles basemap on R2, fan-out via hibernating DOs.

### Tier A — Hobby / near-zero
| Item | Service | $/mo |
|---|---|---|
| Frontend | Cloudflare Pages (free) | $0 |
| Edge + fan-out + DB | Workers **Free** (DO SQLite + D1, no Cron) | $0 |
| Ingest | self-hosted Raspberry Pi | $0 |
| Tiles/files | R2 (a few GB) | ~$0–1 |
| **Total** | | **~$0–3** |
*(Caveat: Free plan has no Cron Triggers and tighter DO/D1 limits — fine for low traffic.)*

### Tier B — Recommended production
| Item | Service | $/mo |
|---|---|---|
| Frontend | Cloudflare Pages | $0 |
| Workers + DO + D1 + Cron | Workers **Paid** ($5 base incl. 10M req) | $5 |
| Ingest singleton | Fly shared-cpu-1x (or Railway) | $2–5 |
| Tiles/files | R2 ($0.015/GB, no egress) | ~$1 |
| Database | D1 (within included) | $0 |
| Domain | registrar (amortized) | ~$1.50 |
| **Total** | | **~$9–13** |

### Tier C — Headroom / true Postgres
| Add-on | Why | $/mo |
|---|---|---|
| Neon (Postgres + PostGIS) | richer geo / outgrow D1 writes | free–~$19 |
| 2nd ingest region | redundancy / sharding | +$2–5 |
| Workers overages | high request/CPU volume | +$ |
| **Total** | | **~$25–40** |

**Savings vs v1 (Netlify + Fly + Supabase, ~$30–85):** the floor drops from ~$30 to **~$9–13**,
driven by $0 frontend + zero egress (Pages/R2), DO hibernation (idle ≈ free), free outgoing
fan-out, and D1 replacing managed Postgres.

**Biggest residual cost risks & their dials:** D1 **write** volume (→ filter + selective
persist + TTL); R2 **Class A** ops (→ batch, avoid chatty lists); the always-on ingest box
(→ Pi for $0). None scale steeply with users because fan-out is the free direction.

---

## 9. Environment / config

```
# ingest box (Fly secrets or Pi .env)
APRSIS_HOST=rotate.aprs2.net
APRSIS_PORT=14580
APRSIS_CALLSIGN=N0CALL          # receive-only default
APRSIS_PASSCODE=-1              # -1 = RX only
APRSIS_FILTER=r/40.0/-105.0/200
INGEST_URL=https://gateway.<you>.workers.dev/ingest
INGEST_SECRET=...              # shared secret for POST auth
BATCH_MS=1500

# workers/gateway/wrangler.toml bindings
#   [[durable_objects.bindings]] name="ROOMS" class_name="RegionRoom"
#   [[d1_databases]] binding="DB" database_name="aprsweb"
#   [[r2_buckets]]  binding="TILES" bucket_name="aprsweb-tiles"
#   [triggers] crons = ["0 4 * * *"]   # nightly cleanup

# apps/web (Pages env)
VITE_WS_URL=wss://gateway.<you>.workers.dev
VITE_API_URL=https://gateway.<you>.workers.dev
VITE_PMTILES_URL=https://<r2-public>/basemap.pmtiles
```

---

## 10. CLAUDE.md conventions (copy into a real CLAUDE.md)

```md
# CLAUDE.md — APRSWeb (cost-optimized)

## Project
Clean-room reimplementation of the APRStac feature set from OPEN specs only. Never copy
APRStac code/assets/branding.

## Stack
pnpm monorepo. apps/web = React SPA → Cloudflare Pages. workers/gateway = Worker + Durable
Objects + D1 + R2. apps/ingest = tiny always-on APRS-IS forwarder (Fly/Railway/Pi).
packages/aprs = pure parser (must run in Worker, Node, and browser).

## Cost rules (treat as requirements)
- Filter APRS-IS server-side; never pull the full firehose.
- Persist SELECTIVELY: latest station state + downsampled sensors + bounded logs. Not every frame.
- BATCH ingest→Worker POSTs. Minimize D1 row-writes and DO requests.
- Use DO Hibernation API (acceptWebSocket + serializeAttachment). Never ws.accept() for client sockets.
- Clients send few messages (incoming bills 20:1); fan-out is server→client (free).
- TTL/roll-up via nightly Cron. Cap stations table.
- Avoid R2 Class A (write/list) churn.

## Commands
pnpm -r build | pnpm -r test | pnpm --filter web dev | wrangler dev | (ingest) pnpm --filter ingest dev
```

---

## 11. Deploy commands

```bash
# D1 + R2 + Worker (Cloudflare)
wrangler d1 create aprsweb
wrangler d1 migrations apply aprsweb
wrangler r2 bucket create aprsweb-tiles
wrangler deploy                       # in workers/gateway

# Frontend (Cloudflare Pages)
#   connect repo, build: pnpm --filter web build, output dir: apps/web/dist
wrangler pages deploy apps/web/dist

# Ingest box (Fly) — or run the same container on a Raspberry Pi
fly launch --no-deploy                # in apps/ingest
fly secrets set APRSIS_FILTER=... INGEST_URL=... INGEST_SECRET=...
fly deploy
```

---

## 12. Open questions

1. **D1 vs Neon:** start on D1 (cheapest) and only migrate if write volume or geo needs force it?
2. **Ingest home:** $2 Fly machine vs $0 Raspberry Pi — is self-hosting acceptable for uptime?
3. **Region sharding:** one global DO room, or one DO per geo bucket (better fan-out, more objects)?
4. **Transmit:** ship Phase 9 at all, or stay receive-only to avoid all regulatory surface?
5. **Retention:** how many days of packets/sensors to keep (drives D1 write/storage cost)?
