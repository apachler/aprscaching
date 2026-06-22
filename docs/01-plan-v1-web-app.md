# APRSWeb — Implementation Plan

A clean-room, web-native reimplementation of the **APRStac** feature set, built from open
APRS protocol specifications (not from APRStac's closed-source binary). The frontend deploys
to **Netlify**; an always-on companion worker handles the parts Netlify structurally cannot.

> **Clean-room rule (non-negotiable):** Do not decompile, copy, or reference APRStac's
> binary, assets, markup, or branding. Build only from public specs: APRS101, the APRS-IS
> protocol, AX.25/KISS, and the Meshtastic and TAK/CoT public protocols. "APRStac" appears
> in this document only to describe target functionality.

---

## 0. How to use this file with Claude Code

1. `git init aprsweb && cd aprsweb`, drop this file in as `PLAN.md`.
2. Copy the **CLAUDE.md conventions** block (§11) into a real `CLAUDE.md`.
3. Run `claude`, then drive it phase by phase, e.g.
   *"Read PLAN.md. Implement Phase 0, then stop and show me the tree."*
4. Each phase below has **Tasks** and **Acceptance criteria** — treat acceptance criteria
   as the definition of done before moving on.

---

## 1. What APRStac does, and what survives the move to the web

APRStac is a single ~10 MB local binary that runs a web server and bundles a lot of
roles. Reimplementing it as a cloud web app forces every feature into one of three buckets.

### Bucket A — Cloud-friendly (build these as the core web app)
- **Live station map** — positions from the APRS-IS internet feed, plotted on a map with
  heading arrows, grid/MGRS overlays, and station "ghosting" (fade by age).
- **Station status** — green/yellow/red situational reporting (food, water, shelter, power,
  medical, comms, fuel, personnel).
- **Weather/sensor history** — temperature, humidity, pressure, wind, rain over time.
- **Message viewing & sending** over APRS-IS (sending is gated by a valid passcode — see §9).
- **BBS-style message board** — reimagined as a web-native board (not raw AX.25 over RF).
- **Map tiles / offline tiles** — vector basemap, optional packaged offline tiles.

### Bucket B — Needs an always-on server, NOT possible on Netlify
- **APRS-IS connection** — a persistent TCP stream you stay connected to. Browsers can't
  open raw TCP; Netlify functions are short-lived. → lives in the **ingest worker**.
- **Real-time fan-out** — a WebSocket server pushing packets to many clients. → **worker**.
- **IGate (RF↔Internet gating)** and **digipeater** logic as a hosted service. → **worker**
  (and only meaningful if a real RF source is attached; see Bucket C).

### Bucket C — Hardware/RF bound: cloud literally cannot do it
- Serial GPS, **KISS TNC**, soundcard AFSK, **USB/BLE Meshtastic**, VARA FM, serial ports.
- **Web-native answer:** the *browser* can reach local hardware via **Web Serial**,
  **Web USB**, and **Web Bluetooth** (Chromium desktop, HTTPS-only, user-gesture grant).
  This reintroduces KISS-over-serial and Meshtastic-over-serial/BLE *from the SPA itself*,
  no cloud daemon. In-browser soundcard AFSK is a stretch goal (Web Audio DSP).
- Anything truly off-grid/no-internet (APRStac's core emergency use case) is **out of scope**
  for a cloud app by definition. Document this honestly to users.

---

## 2. Architecture

```
                                   ┌─────────────────────────────┐
   Browser (SPA, Netlify CDN)      │  APRS-IS  (rotate.aprs2.net) │
   ┌───────────────────────────┐   └──────────────┬──────────────┘
   │ React + MapLibre + uPlot  │                  │ persistent TCP (14580, filtered)
   │  • live map / charts      │                  ▼
   │  • WebSocket client  ◄─────┼────────┐   ┌──────────────────────────────┐
   │  • Web Serial / BLE  ◄─────┼──► local │  │   INGEST WORKER (Fly.io)     │
   │      (KISS / Meshtastic)   │  hardware │  │  • APRS-IS client + parser   │
   └─────────────┬─────────────┘           │  │  • digipeat / IGate logic    │
                 │ HTTPS REST (history,     │  │  • WebSocket fan-out server  │
                 │ auth, send-message)      └──┤  • writes to Postgres        │
                 ▼                              └───────────────┬──────────────┘
   ┌───────────────────────────┐                               │
   │ Netlify Functions (opt.)  │                               ▼
   │  thin REST/auth glue       │              ┌──────────────────────────────┐
   └─────────────┬─────────────┘               │  Postgres + PostGIS (Supabase)│
                 └──────────────────────────────►  stations, packets, sensors  │
                                                │  + Auth + Storage (fileshare) │
                                                └──────────────────────────────┘
```

**Why this split:** Netlify gives a great CDN-hosted SPA + HTTPS + serverless REST, but
cannot hold the APRS-IS socket or serve WebSockets. One tiny always-on worker covers both.
Postgres+PostGIS handles "stations in this viewport" geo-queries cheaply.

---

## 3. Tech stack (best-fit, with rationale)

| Layer | Choice | Why |
|---|---|---|
| Frontend framework | **React 18 + TypeScript + Vite** | Fast builds, trivial Netlify deploy, huge ecosystem. |
| Map | **MapLibre GL JS + PMTiles (Protomaps)** | Vector tiles, smooth with thousands of markers; PMTiles = a single static file = near-zero tile cost. (Leaflet is the lighter, raster fallback that matches the original.) |
| Charts | **uPlot** | Tiny, extremely fast for time-series sensor history. |
| Styling | **Tailwind CSS** | Velocity; no design system to maintain. |
| Client state / data | **TanStack Query + Zustand** | Query for REST cache, Zustand for live map state. |
| Live transport | **WebSocket (native client)** | Push APRS packets as they arrive. |
| Local hardware | **Web Serial / Web USB / Web Bluetooth** | KISS TNC + Meshtastic from the browser (Chromium). |
| Worker runtime | **Node 20 + TypeScript + Fastify** | Shared types/parser with frontend; great socket + WS story. (Go is the perf alternative and matches the single-binary spirit — pick Node for velocity.) |
| WebSocket server | **ws** | Minimal, battle-tested. |
| APRS parsing | **Own `@aprsweb/aprs` package** | Pure, unit-tested; port logic from APRS101, don't depend on abandoned libs. |
| ORM | **Drizzle ORM** | Type-safe, light, SQL-first. |
| Database | **Postgres + PostGIS (Supabase)** | Geo bounding-box queries; Supabase bundles Auth + Storage. (Neon is the cheaper DB-only option.) |
| Auth | **Supabase Auth** | Email/OAuth; stores user callsign + APRS-IS filter + (optional) passcode. |
| Object storage | **Supabase Storage or Cloudflare R2** | Fileshare + PMTiles hosting; R2 has no egress fees. |
| Pub/sub (scale-out, optional) | **Upstash Redis** | Only if the worker runs >1 instance. |
| Monorepo | **pnpm workspaces** | Share `@aprsweb/aprs` and types across web + worker. |

---

## 4. Repository structure

```
aprsweb/
├─ CLAUDE.md                 # conventions (see §11)
├─ PLAN.md                   # this file
├─ package.json              # pnpm workspace root
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ web/                   # React SPA  → deploys to Netlify
│  │  ├─ src/
│  │  │  ├─ map/             # MapLibre setup, station layer, ghosting
│  │  │  ├─ panels/          # station detail, messages, weather charts
│  │  │  ├─ live/            # WebSocket client + viewport subscription
│  │  │  ├─ hardware/        # Web Serial / BLE (KISS, Meshtastic)
│  │  │  └─ lib/
│  │  └─ netlify.toml
│  └─ ingest/                # always-on worker → Fly.io
│     ├─ src/
│     │  ├─ aprsis/          # APRS-IS TCP client, login, filters, reconnect
│     │  ├─ pipeline/        # parse → normalize → upsert → broadcast
│     │  ├─ digipeat/        # WIDEn-N path expansion, dedupe (cross-port)
│     │  ├─ igate/           # IS↔RF gating rules (guarded; off by default)
│     │  ├─ ws/              # WebSocket fan-out server
│     │  └─ http/            # Fastify REST (history, send-message)
│     ├─ fly.toml
│     └─ Dockerfile
├─ packages/
│  ├─ aprs/                  # @aprsweb/aprs — pure parser/encoder + types
│  └─ shared/               # zod schemas, shared DTOs
└─ db/
   ├─ schema.ts              # Drizzle schema
   └─ migrations/
```

---

## 5. Data model (Postgres + PostGIS)

```sql
-- latest known state per station (fast map reads)
stations(
  callsign      text primary key,
  ssid          int,
  symbol        text,           -- APRS symbol table/code
  last_seen     timestamptz,
  position      geography(Point,4326),
  course_deg    int, speed_kn   int, altitude_m int,
  status_color  text,           -- green|yellow|red (optional)
  comment       text
);
create index on stations using gist (position);

-- append-only raw + parsed log (history, replay, debugging)
packets(
  id            bigserial primary key,
  received_at   timestamptz default now(),
  source        text,           -- 'aprs-is' | 'rf:<port>' | 'meshtastic'
  src_callsign  text,
  raw           text,           -- TNC2 line
  kind          text,           -- position|message|weather|telemetry|status|object
  parsed        jsonb
);
create index on packets (src_callsign, received_at desc);

-- time-series weather/telemetry (consider a rollup/partition for volume)
sensor_readings(
  station       text, ts timestamptz,
  temp_c numeric, humidity numeric, pressure_hpa numeric,
  wind_dir int, wind_kn numeric, rain_mm numeric,
  primary key (station, ts)
);

messages(
  id bigserial primary key, ts timestamptz default now(),
  from_call text, to_call text, body text, ack text,
  direction text                -- inbound|outbound
);

-- web-native BBS board
bbs_posts(id bigserial primary key, author text, subject text,
          body text, ts timestamptz default now());

profiles(                       -- Supabase auth user ↔ ham identity
  user_id uuid primary key,
  callsign text, default_filter text,
  passcode text                 -- encrypted at rest; only if user transmits
);
```

---

## 6. APRS-IS ingestion (the heart of the worker)

- **Server:** `rotate.aprs2.net:14580` (filtered port). Use server-side filters so you never
  pull the full firehose: range `r/<lat>/<lon>/<km>`, prefix `p/<calls>`, buddy `b/<call>`.
- **Login line:** `user <CALL> pass <PASSCODE> vers APRSWeb <ver> filter <filter>`.
  Use `pass -1` for **receive-only** (the safe default; no transmit, no licensing concern).
- **Pipeline:** read line → parse (`@aprsweb/aprs`) → normalize → `upsert stations`,
  `insert packets`, `insert sensor_readings` if weather → **broadcast** to WS subscribers.
- **Resilience:** auto-reconnect w/ backoff, keepalive (`#` comments), dedupe by
  `src+payload+window`, bound the `stations` table (cap like APRStac's `max_stations`).
- **Volume control is a cost lever** (§10): tighter filters = fewer packets = lower DB writes
  and WS bandwidth.

---

## 7. Real-time fan-out

- WebSocket server in the worker. Clients send a **viewport subscription**
  `{bbox, maxAgeSec}`; server streams only matching station updates (not the whole feed).
- Message shapes live in `packages/shared` (zod). Send **deltas**, not full snapshots.
- On (re)connect, client pulls a REST snapshot of `stations` in bbox, then live-patches.

---

## 8. Implementation phases (Claude Code executes these)

### Phase 0 — Scaffold
**Tasks:** pnpm workspace; `apps/web` (Vite React TS), `apps/ingest` (Fastify TS),
`packages/aprs`, `packages/shared`; shared tsconfig/eslint/prettier; CLAUDE.md.
**Acceptance:** `pnpm -r build` passes; `apps/web` shows a blank map; `apps/ingest` serves
`GET /health → 200`.

### Phase 1 — `@aprsweb/aprs` parser (pure, test-first)
**Tasks:** parse TNC2 frames; decode position (uncompressed + compressed), MIC-E, weather,
message+ack, status, object/item, telemetry; encode outbound messages. Maidenhead↔latlon,
MGRS helpers.
**Acceptance:** Vitest suite with real sample frames per type; 100% of sample corpus parses;
round-trip encode/decode for messages. **No network here.**

### Phase 2 — Ingest: connect + store
**Tasks:** APRS-IS client (login, filter, reconnect, keepalive); pipeline to Drizzle/Postgres;
station upsert + packet/sensor inserts; `max_stations` cap + ghost-age cleanup job.
**Acceptance:** Pointed at a live filtered feed, `stations`/`packets` populate; reconnect
survives a forced socket drop; volume stays within the configured filter.

### Phase 3 — WebSocket fan-out + viewport subscriptions
**Tasks:** `ws` server; subscription protocol; bbox filtering; delta broadcasting; REST
`GET /stations?bbox=…` snapshot; `GET /stations/:call/history`.
**Acceptance:** Two browser tabs with different bboxes receive only their stations; live
marker appears <2 s after a packet.

### Phase 4 — Web app: live map
**Tasks:** MapLibre + PMTiles basemap; station layer with APRS symbols, heading arrows,
ghosting by age; Maidenhead grid + MGRS overlays; viewport-driven WS subscription;
snapshot-then-patch on connect.
**Acceptance:** Live map shows real stations moving; pan/zoom re-subscribes; 5k markers stay
smooth (clustering or symbol layer).

### Phase 5 — Station detail, messages, weather
**Tasks:** detail panel (last heard, path, symbol, comment, status color); message
inbox/thread view; uPlot charts for sensor history with range selector.
**Acceptance:** Selecting a station shows its history; weather station renders multi-series
charts; messages list and thread correctly.

### Phase 6 — Auth + profile
**Tasks:** Supabase Auth; profile stores callsign + default filter; per-user saved views;
encrypt passcode at rest (only captured if user opts into transmit).
**Acceptance:** Sign in/out; profile persists; receive-only works with no passcode.

### Phase 7 — Transmit over APRS-IS (gated)  ⚠️ regulatory — read §9
**Tasks:** outbound messaging via authenticated APRS-IS session using the user's own
callsign+passcode; ack handling/retransmit; clear UI that transmitting requires a license.
**Acceptance:** A licensed tester sends/receives an APRS message end-to-end; unlicensed/no-
passcode users are blocked in UI and server-side.

### Phase 8 — Local hardware via Web Serial / BLE (stretch)
**Tasks:** Web Serial KISS TNC port (frame/deframe in-browser); Web Bluetooth/USB Meshtastic
import of node positions; feed local frames into the same map + (optionally) up to the worker
for IGate. Document Chromium-only + HTTPS + permission-grant constraints.
**Acceptance:** With a KISS TNC attached, locally-heard stations appear on the map without the
cloud feed; Meshtastic nodes import.

### Phase 9 — BBS board + fileshare (web-native)
**Tasks:** `bbs_posts` CRUD UI; fileshare via Supabase Storage/R2 with MD5 verify.
**Acceptance:** Post/read board; upload/download a file with integrity check.

### Phase 10 — Deploy + harden
**Tasks:** Netlify deploy of `apps/web`; Fly deploy of `apps/ingest` (+ optional standby);
Supabase project + migrations; env wiring; rate limits; structured logs + uptime check;
WS backpressure; cost guardrails (filter caps, payload size limits).
**Acceptance:** Public URL live; worker auto-restarts; load test of ~200 concurrent WS clients
holds; documented runbook.

---

## 9. ⚠️ Regulatory note (transmit features)

Receiving and displaying APRS-IS data needs no license. **Transmitting** (messaging, IGate
gating to RF) is amateur-radio activity: it requires the operator's own valid callsign and
APRS-IS passcode, and is subject to local regulations (e.g. FCC Part 97 in the US — no
encryption of content, station ID rules, control-operator requirements). Keep transmit
**off by default**, gate it behind a verified callsign + passcode, and never ship a shared/
hard-coded passcode. Phases 0–6 are receive-only and carry none of this risk.

---

## 10. Cost estimate — 1000 active users/month

**Assumptions:** ~1000 monthly actives, ~100–200 peak concurrent WebSocket clients,
a *filtered* APRS-IS feed (regional, not the global firehose), SPA bundle CDN-cached, basemap
served as a static PMTiles file. The cost driver here is **fixed infrastructure + WS
bandwidth**, not per-user compute — a read-heavy realtime map scales gently.

| Component | Service / plan | Est. $/mo |
|---|---|---|
| Frontend hosting | Netlify (Free likely sufficient; Pro for headroom) | $0–19 |
| Always-on worker | Fly.io shared-cpu-1x 512 MB (+ optional standby) | $5–25 |
| Database + Auth + Storage | Supabase Pro (8 GB DB, 100 GB storage, 250 GB egress) | $25 |
| Tiles / object storage | Cloudflare R2 (PMTiles + fileshare; no egress fees) | $1–5 |
| Redis pub/sub (only if worker >1 instance) | Upstash | $0–10 |
| Domain (amortized) | registrar | ~$1.50 |
| **Lean total** (Netlify Free + Neon free + Fly + R2) |  | **≈ $10–20** |
| **Comfortable total** (Netlify Pro + Supabase Pro + Fly ×2 + R2) |  | **≈ $70–85** |

**Notes & levers**
- Biggest hidden cost = **WS fan-out bandwidth** = packet_rate × concurrent_clients. Control
  it with tight server-side APRS-IS filters, delta-only updates, and viewport subscriptions.
- DB growth from `packets`/`sensor_readings` is the second lever — partition/rollup old data,
  enforce `max_stations`, and TTL the raw packet log.
- True hobby scale can sit near **$10–15/mo**; the $70–85 figure buys redundancy + headroom.

---

## 11. CLAUDE.md conventions (copy into a real CLAUDE.md)

```md
# CLAUDE.md — APRSWeb

## Project
Clean-room, web-native reimplementation of the APRStac feature set from OPEN specs only
(APRS101, APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT). Never copy APRStac code/assets/branding.

## Stack
pnpm monorepo. apps/web = React+TS+Vite+MapLibre (Netlify). apps/ingest = Node+TS+Fastify+ws
(Fly.io). packages/aprs = pure parser. DB = Postgres+PostGIS via Drizzle (Supabase).

## Rules
- TypeScript strict. Zod-validate all external input (APRS frames, WS msgs, REST bodies).
- packages/aprs stays PURE: no network, no DB, fully unit-tested (Vitest).
- Transmit is OFF by default and gated by a verified callsign + passcode (see PLAN §9).
- Prefer deltas over snapshots on the WS. Always filter by bbox + age.
- Commands: `pnpm -r build`, `pnpm -r test`, `pnpm --filter web dev`, `pnpm --filter ingest dev`.
- Don't add a feature unless it maps to a PLAN.md phase; update PLAN.md if scope changes.
```

---

## 12. Environment variables

```
# ingest worker (Fly secrets)
DATABASE_URL=postgres://...
APRSIS_HOST=rotate.aprs2.net
APRSIS_PORT=14580
APRSIS_CALLSIGN=N0CALL          # receive-only default
APRSIS_PASSCODE=-1              # -1 = RX only
APRSIS_FILTER=r/40.0/-105.0/200
WS_ALLOWED_ORIGIN=https://<your-netlify-site>

# web (Netlify env)
VITE_WS_URL=wss://<your-fly-app>.fly.dev
VITE_API_URL=https://<your-fly-app>.fly.dev
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_PMTILES_URL=https://<r2-or-netlify>/basemap.pmtiles
```

---

## 13. Commands cheat-sheet

```bash
# scaffold / dev
pnpm install
pnpm --filter web dev
pnpm --filter ingest dev
pnpm -r test

# deploy frontend (Netlify)
#   build cmd: pnpm --filter web build   |   publish dir: apps/web/dist

# deploy worker (Fly.io)
fly launch --no-deploy            # in apps/ingest
fly secrets set DATABASE_URL=... APRSIS_FILTER=...
fly deploy

# db migrations (Drizzle)
pnpm --filter db migrate
```

---

## 14. Open questions to resolve before Phase 2

1. **Coverage:** one global regional filter, or per-user filters (changes worker fan-out design)?
2. **Transmit:** ship Phase 7 at all, or stay receive-only to dodge all regulatory surface?
3. **History depth:** how long to retain `packets`/`sensor_readings` (drives DB cost)?
4. **Hardware:** is Web Serial/BLE (Phase 8) in scope, or pure cloud-feed only?
5. **DB choice:** Supabase (all-in-one) vs Neon + separate auth (cheaper, more wiring)?
