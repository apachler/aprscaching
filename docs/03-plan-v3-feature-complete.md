# APRSWeb — Final Implementation Plan (feature-complete vs APRStac)

A clean-room, web-native reimplementation of the **full APRStac feature set**, committed to the
**recommended (Tier B) Cloudflare stack**, with **Tier C headroom** noted for later. Built only
from open specs (APRS101, APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT) — never from APRStac's
closed-source binary, assets, or branding.

**Committed stack (Tier B, ~$9–13/mo):** Cloudflare Pages (SPA) · Workers + Durable Objects
(fan-out) · D1 + R2 (data/storage) · one tiny always-on **ingest** container on Fly/Railway (or
self-hosted on a Raspberry Pi). **Headroom (Tier C, ~$25–40/mo)** is itemized in §6 for when you
outgrow it.

---

## 1. Feature parity with APRStac

Every capability APRStac advertises (homepage + FAQ + changelog), mapped to where it lives here.
Runtime legend: **web** = browser SPA, **edge** = Worker/Durable Object, **ingest** = the
always-on box, **browser-hw** = local hardware via Web Serial/USB/Bluetooth.

| APRStac feature | APRSWeb implementation | Runtime | Milestone |
|---|---|---|---|
| Real-time station map | MapLibre GL station layer | web | M1 |
| Heading arrows | rotated symbol markers | web | M1 |
| Station ghosting (fade by age) | opacity from `last_seen` | web | M1 |
| `max_stations` cap (def. 10k) | D1 cap + nightly cleanup cron | edge | M1 |
| Maidenhead grid overlay | grid layer | web | M2 |
| MGRS coordinates | coordinate overlay/readout | web | M2 |
| Status colors (food/water/shelter/power/medical/comms/fuel/personnel) | `status_color` + category UI | web+edge | M2 |
| Weather/sensor tracking + charts (temp/humidity/pressure/wind/rain, ranges) | `sensor_readings` + uPlot | web+edge | M2 |
| Statistics dashboard (top heard, per-port RX/TX, 24h RX, top BBS users) | stats views over D1 | web+edge | M2 |
| `source_callsign` tracking | packet field in D1 | edge | M2 |
| Discord notifications | Worker → Discord webhook | edge | M2 |
| BBS message board (web-native) | board UI + `bbs_posts` | web+edge | M3 |
| BBS over RF (AX.25 list/read/post) | AX.25 BBS server port | ingest | M5 |
| BBS terminal client to other systems | outbound BBS port | ingest | M3/M5 |
| BBS connection history | history table + view | edge+web | M3 |
| Email gateway (SMTP/IMAP, ACK, threading, retransmit) | email service | ingest | M3 |
| RF Fileshare (browse/download, base64, MD5) | R2 fileshare + AX.25 file port | web/edge (R2) · ingest (RF) | M3/M5 |
| APRS-IS port | source/sink port | ingest (+edge opt) | M1 |
| KISS TCP | port | ingest | M4 |
| Meshtastic TCP | port | ingest | M4 |
| UDP Broadcast | port | ingest | M4 |
| Encrypted TCP | TLS port | ingest | M4 |
| TAK (Cursor-on-Target) | CoT port | ingest/edge | M4 |
| VARA FM | VARA TCP port (to a reachable VARA host) | ingest / local-agent | M4 |
| GPS integration + map follow mode | Geolocation API + Web Serial GPS | web / browser-hw | M4/M5 |
| KISS Serial | Web Serial port | browser-hw | M5 |
| Meshtastic Serial | Web Serial port | browser-hw | M5 |
| Meshtastic Bluetooth | Web Bluetooth port | browser-hw | M5 |
| WIDEn-N digipeater + path expansion | digipeat engine | ingest | M5 |
| Per-port digipeat controls | per-port config | ingest | M5 |
| Cross-port digipeating | packet-bus routing rules | ingest | M5 |
| IGate RF↔IS (qAR constructs, SSID handling) | IGate engine | ingest | M5 (IS→RF = TX, gated) |
| Offline maps + tile cache (LRU, MBTiles) | PMTiles on R2 + Service-Worker Cache + MBTiles→PMTiles tool | web/R2 | M5 |
| LAN/browser access | inherent (it *is* a web app) | — | M1 |
| Responsive mobile interface | responsive SPA / PWA | web | M5 |
| Android app w/ built-in AFSK modem | PWA + Web Audio AFSK modem | web / browser-hw | M5 (PWA) · M6 (AFSK) |
| Single binary, runs on a Pi | ingest ships as one static Go/Node binary | ingest | M1 |
| *(roadmap)* BBS↔BBS mail forwarding (NET/ROM) | mail-forwarding port | ingest | M6 |
| *(roadmap)* HF ports (JS8, PSK31, FT8) | HF transport ports | ingest / local-agent | M6 |
| *(roadmap)* APRS-over-Meshtastic connected modes | mesh connected modes | ingest | M6 |

**Coverage:** every shipped APRStac feature lands in **M1–M5 (Tier B)**. APRStac's own *future*
roadmap items land in **M6 (Tier C/later)**.

### The honest RF caveat
Digipeater, IGate's RF side, BBS-over-RF, RF Fileshare, KISS, and VARA all need an **RF source**.
A pure cloud deployment has only the APRS-IS internet feed, so those features ship in the UI but
stay **inactive until an RF port is attached** — either a **Web Serial TNC in the browser** or a
**TNC on a self-hosted ingest box / Pi**. This mirrors APRStac's own local nature; truly off-grid,
no-internet operation is the one thing a cloud app can't be.

---

## 2. Core design: a port + packet-bus (mirrors APRStac's "ports")

APRStac is fundamentally a multi-transport packet router. APRSWeb adopts the same shape so the
feature set composes cleanly:

- **`Packet`** — one normalized type (`src`, `dst`, `path[]`, `payload`, `kind`, `parsed`, `port`).
- **`Port`** — a pluggable transport implementing `rx()` (emit packets to the bus) and/or `tx()`
  (accept packets to send). Each port has config + per-port digipeat/IGate flags.
- **Bus** — routes packets between ports (enables cross-port digipeating) and to persistence + fan-out.

Ports are hosted in whichever runtime can reach their medium:

| Runtime | Ports it hosts |
|---|---|
| **ingest box** (always-on, network-reachable) | APRS-IS, KISS-TCP, Meshtastic-TCP, VARA-FM, UDP, Encrypted-TCP, TAK/CoT, Email, serial GPS/TNC (if box has serial), BBS/Fileshare-over-RF |
| **browser** (local hardware) | KISS-Serial, Meshtastic-Serial, Meshtastic-BLE, Geolocation GPS, AFSK soundcard *(M6)* |
| **edge** (internet services) | APRS-IS (optional), Discord, TAK-over-IP, web-native BBS & Fileshare (R2) |

`@aprsweb/aprs` (pure parser/encoder) runs in **all three** runtimes unchanged.

---

## 3. Architecture (Tier B)

```
   Browser SPA (Cloudflare Pages, free)            ┌──────────────────────────┐
   ┌──────────────────────────────┐                │ APRS-IS / KISS-TCP / Mesh │
   │ React + MapLibre + uPlot     │                │ VARA / UDP / TAK / Email  │
   │  • WS client (live deltas)   │◄──WS──┐         └─────────────┬────────────┘
   │  • browser-hw ports          │       │                       │ persistent (filtered)
   │    (Web Serial/BLE)          │       │                       ▼
   └──────────────┬───────────────┘       │        ┌──────────────────────────────────┐
                  │ HTTPS REST             │        │ INGEST (tiny always-on box)       │
                  ▼                        │        │ Fly $2 · Railway · or Pi $0       │
   ┌──────────────────────────────┐       │        │ • port/packet-bus + digipeat/IGate│
   │ Cloudflare Worker (edge)     │       │        │ • BATCHES → POST /ingest          │
   │ • REST snapshot/history/stats│───────┘        └────────────────┬─────────────────┘
   │ • routes to Durable Objects  │◄────────────────────────────────┘
   │ • writes D1 · Discord webhook│
   └───────┬───────────────┬──────┘
           ▼               ▼
   ┌───────────────┐  ┌──────────────────────────────┐
   │ D1 (SQLite +  │  │ Durable Objects "region rooms"│
   │ R*Tree geo)   │  │ hibernating WS fan-out        │
   └───────────────┘  └──────────────────────────────┘
   R2: PMTiles basemap + fileshare (zero egress)
```

---

## 4. Tech stack (committed)

React + TS + Vite (Pages) · MapLibre GL + PMTiles · uPlot · Tailwind · TanStack Query + Zustand ·
Web Serial/USB/Bluetooth for local hardware · Cloudflare **Workers + Durable Objects (Hibernation
API)** · **D1 (SQLite + R\*Tree)** · **R2** · ingest = **Node 20 + TS** (or Go) on Fly/Railway/Pi ·
`@aprsweb/aprs` pure package · pnpm monorepo.

---

## 5. Data model (D1 / SQLite)

```sql
CREATE TABLE stations (
  callsign TEXT PRIMARY KEY, ssid INTEGER, symbol TEXT,
  lat REAL, lon REAL, last_seen INTEGER,
  course INTEGER, speed_kn INTEGER, altitude_m INTEGER,
  status_color TEXT, comment TEXT, source_call TEXT
);
CREATE VIRTUAL TABLE station_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

CREATE TABLE sensor_readings (
  station TEXT, ts INTEGER, temp_c REAL, humidity REAL, pressure_hpa REAL,
  wind_dir INTEGER, wind_kn REAL, rain_mm REAL, PRIMARY KEY (station, ts));

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER,
  from_call TEXT, to_call TEXT, body TEXT, ack TEXT, direction TEXT);

CREATE TABLE bbs_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, subject TEXT, body TEXT, ts INTEGER);
CREATE TABLE bbs_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT, port TEXT, connected_at INTEGER, action TEXT);

CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, r2_key TEXT, size INTEGER, md5 TEXT, ts INTEGER);

CREATE TABLE port_stats (
  port TEXT, ts INTEGER, rx INTEGER, tx INTEGER, PRIMARY KEY (port, ts));

CREATE TABLE packets_recent (   -- thin, hard-TTL'd debug log (NOT the full firehose)
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, src_call TEXT, kind TEXT, raw TEXT, port TEXT);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY, callsign TEXT, default_filter TEXT, saved_views TEXT);
```

---

## 6. Cost (committed Tier B; Tier C noted)

**Assumptions:** ~1000 monthly actives, ~100–200 peak concurrent, *filtered* regional APRS-IS feed,
selective persistence, PMTiles on R2, hibernating DO fan-out.

### Tier B — recommended (build this)
| Item | Service | $/mo |
|---|---|---|
| Frontend | Cloudflare Pages | $0 |
| Workers + DO + D1 + Cron | Workers Paid ($5 base, 10M req incl.) | $5 |
| Ingest singleton | Fly shared-cpu-1x (or Railway; or Pi $0) | $2–5 |
| Tiles/files | R2 ($0.015/GB, zero egress) | ~$1 |
| Database | D1 (within included) | $0 |
| Domain | amortized | ~$1.50 |
| **Total** | | **~$9–13** |

### Tier C — headroom (later, when needed)
| Add-on | Trigger | $/mo |
|---|---|---|
| Neon (Postgres + PostGIS) | outgrow D1 writes / need richer geo | free–~$19 |
| 2nd ingest region + DO sharding | redundancy / higher RF volume | +$2–5 |
| Workers/D1 overages | high request or write volume | +$ |
| **Total** | | **~$25–40** |

**Why Tier B stays cheap as users grow:** fan-out is server→client (free on DO); idle viewers
hibernate (no duration charge); frontend egress is $0 (Pages/R2). Cost dials: tighter APRS-IS
filter, selective persistence, batched ingest POSTs, nightly TTL/roll-up, avoid R2 Class-A churn.

---

## 7. Milestones & phases (committed build order)

Acceptance criteria are the definition of done. Drive Claude Code one milestone at a time.

### M1 — Live receive spine (Tier B core)
- **P0 Scaffold:** pnpm monorepo; Pages SPA; Worker (`wrangler`) with DO + D1 + R2 bindings; ingest
  service; `@aprsweb/aprs` + `shared`; create D1/R2 via `wrangler`.
- **P1 Parser:** `@aprsweb/aprs` — position (compressed/uncompressed), MIC-E, weather, message+ack,
  status, object/item, telemetry; encode messages; Maidenhead/MGRS. *Test-first, pure.*
- **P2 Port + bus:** `Packet` type, `Port` interface, bus + registry, per-port config.
- **P3 Ingest APRS-IS:** filtered APRS-IS port, reconnect/keepalive, batch → authed `POST /ingest`.
  Ship ingest as a single binary (Pi-friendly).
- **P4 Worker ingest:** verify secret; selective D1 upserts (station + R\*Tree, `max_stations`);
  route deltas to region DO.
- **P5 DO fan-out:** hibernatable WS, `subscribe {bbox, maxAge}` via `serializeAttachment`,
  broadcast matching deltas only.
- **P6 Map:** MapLibre + PMTiles; stations, heading arrows, ghosting; viewport subscribe;
  snapshot-then-patch.
- **Acceptance:** live map of real APRS-IS stations; pan/zoom re-subscribes; 5k markers smooth;
  idle WS shows no DO duration charges.

### M2 — Situational-awareness parity
- Maidenhead grid + MGRS overlays · status colors (8 categories) · weather sensor charts (uPlot,
  ranges) · statistics dashboard (top heard, per-port RX/TX, 24h RX, top BBS users) ·
  `source_callsign` tracking · Discord webhook notifications · auth + profile + saved views.
- **Acceptance:** status legend filters the map; weather station charts render; stats dashboard
  populates; a Discord alert fires on a configured trigger.

### M3 — Connected services parity
- Web-native BBS board (post/read) · BBS connection-history view · email gateway (SMTP/IMAP, auto
  ACK, threading, retransmit) · R2 fileshare (upload/download, MD5 verify).
- **Acceptance:** post/read board; an inbound APRS message forwards to email and a reply returns;
  upload+download a file with MD5 match.

### M4 — Multi-transport ports
- ingest ports: KISS-TCP · Meshtastic-TCP · UDP broadcast · Encrypted TCP · TAK/CoT · VARA-FM (to a
  reachable VARA host) · GPS (browser Geolocation) + map follow mode.
- **Acceptance:** each port ingests/forwards on the shared bus; a Meshtastic-TCP node's positions
  appear on the map; CoT round-trips to a TAK client; follow-mode tracks own position.

### M5 — RF features + local hardware (completes Tier B)
- Web Serial KISS + Meshtastic-Serial · Web Bluetooth Meshtastic · WIDEn-N digipeater (path
  expansion, per-port, cross-port) · IGate RF↔IS (qAR, SSID) · BBS/Fileshare over AX.25 · offline
  maps (PMTiles + Service-Worker cache + MBTiles→PMTiles import) · responsive PWA · **transmit
  gating** (messaging TX + IGate IS→RF, callsign+passcode required — see §8).
- **Acceptance:** with a Web Serial TNC, locally-heard stations map without the cloud feed;
  digipeater repeats a WIDEn-N frame across ports; PWA installs and works offline on cached tiles;
  TX is blocked without a verified callsign.

### M6 — Headroom / later (Tier C)
- AFSK-in-browser modem (Web Audio) · HF ports (JS8/PSK31/FT8) · BBS↔BBS mail forwarding (NET/ROM)
  · APRS-over-Meshtastic connected modes · Neon/PostGIS migration · multi-region DO sharding +
  redundant ingest · *(optional)* APRS-Caching-style presence-verified check-ins (see §10).

---

## 8. ⚠️ Regulatory note
Receiving/displaying APRS-IS data needs no license. **Transmitting** (messaging, IGate IS→RF)
requires the operator's own valid callsign + passcode and is subject to local rules (e.g. FCC Part
97). Keep TX **off by default**, gate behind a verified callsign, never ship a shared passcode.
Everything through M4 (and the receive side of M5) is receive-only.

---

## 9. Config / commands / conventions

```
# ingest (.env / Fly secrets)
APRSIS_HOST=rotate.aprs2.net   APRSIS_PORT=14580
APRSIS_CALLSIGN=N0CALL  APRSIS_PASSCODE=-1   APRSIS_FILTER=r/40.0/-105.0/200
INGEST_URL=https://gateway.<you>.workers.dev/ingest  INGEST_SECRET=...  BATCH_MS=1500

# wrangler.toml bindings: DO "ROOMS", D1 "DB", R2 "TILES", crons=["0 4 * * *"]
# web (Pages env): VITE_WS_URL, VITE_API_URL, VITE_PMTILES_URL
```

```bash
wrangler d1 create aprsweb && wrangler d1 migrations apply aprsweb
wrangler r2 bucket create aprsweb-tiles
wrangler deploy                 # workers/gateway
wrangler pages deploy apps/web/dist
fly launch --no-deploy && fly deploy   # apps/ingest  (or run the binary on a Pi)
```

**CLAUDE.md rules:** clean-room only; `@aprsweb/aprs` stays pure (runs in Worker+Node+browser);
filter feed server-side; persist selectively; batch ingest POSTs; DO Hibernation API only
(`acceptWebSocket`); TX off by default + gated; TTL via cron; everything is a Port on the bus.

---

## 10. Optional later integration — APRS Caching (researched)
APRS Caching (aprscaching.com / socialhams, by OE8APR) is a geocaching variant where a find is
logged via APRS, so the logger's beaconed position *verifies presence* at the cache. Because
APRSWeb already ingests and stores positions, a presence-verified "check-in / cache log" feature
would be a natural **M6** add-on (match a user's APRS position to a target coordinate within a
radius/time window). Not part of APRStac parity — listed only as a future idea.
