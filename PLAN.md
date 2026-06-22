# aprscaching.com — Reborn: Product & Implementation Plan

A modern, **APRS-Caching-first** web workbench — the rebirth of the original socialhams APRS
Caching (OE8APR, 2016). APRS Caching is the **product**; a full APRS workbench (live map,
multi-transport, messaging, RF tooling) is the **platform** it runs on. Hosted on
**aprscaching.com**.

**Stack (committed, Tier B ~$9–13/mo):** Cloudflare Pages (SPA, custom domain `aprscaching.com`,
free SSL) · Workers + Durable Objects (real-time) · D1 + R2 · one tiny always-on **ingest** box
(Fly/Railway, or self-hosted on a Pi). Headroom (Tier C ~$25–40/mo: Neon/PostGIS, redundant
ingest, DO sharding) noted in §8.

> **IP note:** APRS Caching is the author's own work — build it freely. The *workbench*
> capabilities are reimplemented from open specs (APRS101, APRS-IS, AX.25/KISS, Meshtastic,
> TAK/CoT) and must stay independent of APRStac's (KN4MKB's) closed-source code/assets.

---

## 1. Product vision: what "first-class" means

The original made the find verifiable by logging it over APRS. The reborn version makes that the
*centre of gravity*, and uses real-time infrastructure to do what 2016 couldn't:

1. **Presence-verified finds** — a find is confirmed when the logger's beaconed APRS position
   falls within a cache's radius inside a time window. (§4)
2. **Real-time geofencing** — as your position streams in, the app proactively pings *"you're at
   cache AC-1234 — log it?"* No manual coordinate-checking.
3. **Living caches as a true type** — an APRS station that beacons becomes a moving cache; finding
   it means being co-located with it at a moment in time.
4. **Trustworthy verification** — RF-heard, IGate-corroborated positions are trusted; bare
   APRS-IS injections are flagged (anti-spoofing, §4.3).
5. **Field-native** — because the workbench speaks RF, you can log a find over the air, off-grid,
   not just from a desk.
6. **Heritage continuity** — OpenCaching/SOTA/POTA sync, GPX import/export, callsign identity, and
   the socialhams social layer, reborn.

---

## 2. Domain model (D1 / SQLite) — the new core

```sql
-- CACHES: the heart of the product
CREATE TABLE caches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,                 -- AC-1234 (native) or imported code
  owner_call TEXT,
  title TEXT,
  type TEXT,                        -- single | two_stage | multi | aprs_living | audio | traditional | sota | pota
  status TEXT,                      -- active | disabled | archived
  difficulty REAL, terrain REAL,    -- 1.0–5.0
  lat REAL, lon REAL,               -- final coords (or stage-1 for staged)
  station_call TEXT,                -- aprs_living: the beaconing station that *is* the cache
  source TEXT,                      -- native | opencaching | sota | pota
  external_id TEXT,                 -- OC code / SOTA ref / POTA ref
  hint TEXT, description TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE VIRTUAL TABLE cache_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

CREATE TABLE cache_stages (
  cache_id INTEGER, stage_no INTEGER, lat REAL, lon REAL,
  clue TEXT, unlock TEXT,           -- coords | audio | puzzle
  PRIMARY KEY (cache_id, stage_no)
);

CREATE TABLE cache_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id INTEGER, logger_call TEXT, ts INTEGER,
  log_type TEXT,                    -- found | dnf | note | maintenance | enabled | disabled
  verified INTEGER,                 -- 0/1
  verify_method TEXT,               -- aprs_rf | aprs_is | manual | none
  trust TEXT,                       -- high | low | none
  matched_position_id INTEGER, distance_m REAL,
  comment TEXT
);

-- POSITION HISTORY for verification (loggers kept longer than firehose TTL)
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign TEXT, ts INTEGER, lat REAL, lon REAL,
  heard_via TEXT,                   -- rf | aprs_is   (rf trusted more)
  igate_call TEXT, path TEXT
);
CREATE INDEX idx_positions_call_ts ON positions(callsign, ts);

-- IDENTITY (callsign-based, like the original)
CREATE TABLE accounts (
  callsign TEXT PRIMARY KEY,
  verified INTEGER, verify_method TEXT, verified_at INTEGER,
  display_name TEXT, home_grid TEXT, created_at INTEGER
);

-- GAMIFICATION / SOCIAL
CREATE TABLE achievements (callsign TEXT, badge TEXT, earned_at INTEGER, PRIMARY KEY(callsign,badge));
CREATE TABLE favorites    (callsign TEXT, cache_id INTEGER, PRIMARY KEY(callsign,cache_id));
CREATE TABLE watches      (callsign TEXT, cache_id INTEGER, PRIMARY KEY(callsign,cache_id));
```

(Workbench tables — stations, sensor_readings, messages, bbs_*, files, port_stats — carry over
from the workbench plan and share the same D1 database.)

---

## 3. Architecture (caching-first view)

```
   aprscaching.com  (Cloudflare Pages SPA, custom domain)
   ┌─────────────────────────────────────────────┐
   │ Cache map (primary) + live stations (layer)  │      ┌──────────────────────────┐
   │ • "near a cache?" real-time prompts ◄────WS──┼──┐   │ APRS-IS / KISS / Mesh /  │
   │ • log find · cache detail · profile          │  │   │ VARA / UDP / TAK / RF    │
   │ • Web Serial/BLE (log over RF in the field)  │  │   └────────────┬─────────────┘
   └───────────────────────┬──────────────────────┘  │                │ persistent
                           │ HTTPS /api               │ WS             ▼
                           ▼                          │   ┌──────────────────────────────┐
   ┌──────────────────────────────────────────┐      │   │ INGEST (always-on, Fly/Pi)    │
   │ Cloudflare Worker (api.aprscaching.com)   │      │   │ port/packet-bus + digipeat    │
   │ • caches/logs/profiles REST               │──────┘   │ BATCHES positions → /ingest   │
   │ • VERIFY ENGINE (presence check)          │◄─────────┤                               │
   │ • geofence dispatch → region DO           │          └───────────────┬──────────────┘
   │ • import/sync (OkAPI/SOTA/POTA), GPX       │◄─────────────────────────┘
   │ • writes D1                                │
   └───────┬───────────────────┬───────────────┘
           ▼                   ▼
   ┌───────────────┐   ┌──────────────────────────────────────────┐
   │ D1 (caches +  │   │ Durable Objects "region rooms"            │
   │ positions +   │   │ • hibernating WS fan-out                  │
   │ R*Tree)       │   │ • hold active caches' GEOFENCES per region│
   └───────────────┘   └──────────────────────────────────────────┘
   R2: PMTiles basemap + audio-cache media + GPX (zero egress)
```

---

## 4. The verification engine (crown jewel)

### 4.1 Static / staged caches
On a `found` log (or a confirmed geofence prompt):
```
window  = 30 min (configurable; tighter raises integrity)
radius  = 150 m default; scale down for high difficulty/terrain
pts     = positions[logger_call] where ts in [now-window, now]
for p in pts:
  d = haversine(p, cache.final_coords)
  if d <= radius:
     trust = (p.heard_via == 'rf' && p.igate_call != logger_own_igate) ? 'high' : 'low'
     return { verified: true, trust, matched: p.id, distance_m: d }
return { verified: false }
```

### 4.2 Living / APRS caches (the moving type)
The cache *is* a beaconing station (`station_call`). A find = logger and cache-station
co-located at the same moment:
```
for p in positions[logger_call] in window:
  c = nearestInTime(positions[cache.station_call], p.ts, max_skew=5min)
  if c && haversine(p, c) <= radius: return verified(p, c)
```

### 4.3 Anti-spoofing (what 2016 couldn't fully address)
APRS-IS accepts injected positions, so "seen in APRS-IS" ≠ "was there." Trust tiers:
- **high** — position was **heard over RF** and gated by an **IGate other than the logger's own**
  (independent corroboration), with plausible speed/path between fixes.
- **low** — APRS-IS-only or self-gated; the find is recorded but badged "unverified / IS-only."
- Optional hard mode (owner- or site-policy): only **high-trust** finds count toward leaderboards.
- Plausibility checks: implausible jumps (teleport between fixes), duplicate-path replays, and
  symbol/altitude sanity. Store the evidence (`matched_position_id`, `igate_call`, `path`).

### 4.4 Real-time geofencing
- Each region DO loads active caches in its area (from `cache_rtree`) as **geofences**.
- Every incoming position for a signed-in logger is distance-checked against nearby geofences.
- On entry → push a WS event; the SPA prompts *"You're at AC-1234 — log it?"* One tap runs §4.1/4.2.
- This is the headline modern experience and it rides the *free* fan-out direction (server→client).

---

## 5. Identity (callsign verification, on-brand)

Registration requires a valid callsign (as the original did). Verify control of it:
- **Primary — APRS challenge:** server sends a one-time code as an APRS message to the callsign
  (via ingest TX/RF or APRS-IS); user reads it in their APRS client and enters it. Proves receipt
  on that callsign.
- **Stronger — TX challenge:** user beacons a given token that an independent IGate hears (proves
  transmit control; requires a license — gate appropriately).
- **Fallback — external:** QRZ/HamQTH/LoTW lookup.

---

## 6. Import, interop, heritage

- **OpenCaching** via **OkAPI**, kept in sync (the original imported and maintained OC live).
  Respect OC API terms; store `source=opencaching`, `external_id=OC code`.
- **SOTA** summits via the SOTA API (`type=sota`) — the current site already surfaces these.
- **POTA** parks (`type=pota`) — natural extension.
- **GPX export/import** — load caches into handhelds; import external lists.
- **Legacy migration** — an importer for the original socialhams APRS Caching dataset (caches,
  logs, accounts) to preserve cache codes and find history. *Needs the legacy DB — see questions.*

---

## 7. Milestones (committed build order)

### M0 — Platform spine
Cloudflare scaffold (Pages on `aprscaching.com`, Worker on `api.`, D1/R2/DO) · `@aprsweb/aprs`
pure parser · port/packet-bus · APRS-IS ingest (filtered, batched) · Worker `/ingest` + D1 +
region DO · live map.
**Done when:** real APRS-IS stations render live; positions persist to `positions`.

### M1 — APRS Caching core (first-class)
Cache model + `cache_rtree` · cache map layer (primary markers by type/D/T) · cache detail +
logbook · owner "hide a cache" CRUD · manual logging (found/DNF/note) · callsign accounts +
verification (§5).
**Done when:** you can hide a cache, see it on the map, and log a manual find against it.

### M2 — Presence verification + geofencing (the magic)
Verify engine (§4.1–4.2) · trust tiers + anti-spoof (§4.3) · real-time geofence prompts (§4.4) ·
living/APRS cache type · audio-cache staged unlock (media in R2).
**Done when:** walking/driving into a cache radius triggers a prompt and produces a *high-trust*
verified find from an RF-heard position.

### M3 — Import, interop, heritage
OkAPI OpenCaching sync · SOTA import · (POTA optional) · GPX import/export · legacy data importer.
**Done when:** OC + SOTA caches appear and sync; a user exports a GPX of nearby caches.

### M4 — Social & gamification (socialhams reborn)
Profiles + find stats · leaderboards (finds / points / SOTA-style) · badges/achievements ·
favorites/watchlists · activity feed · cache health (DNF streaks → needs-maintenance).
**Done when:** profiles show verified find counts and a regional leaderboard ranks loggers.

### M5 — Full APRS workbench (platform depth, APRStac-parity)
Messaging · BBS (web + RF) · weather/sensors + charts · multi-transport ports (KISS/Meshtastic/
VARA/UDP/Encrypted-TCP/TAK) · digipeater + IGate · Web Serial/BLE hardware · offline maps/MBTiles
· PWA · transmit gating. (Full parity matrix in the workbench plan; same port/bus.)
**Done when:** aprscaching.com is a real APRS tool — and you can log a find over RF in the field.

### M6 — Headroom / later (Tier C)
AFSK-in-browser · HF ports (JS8/PSK31/FT8) · BBS↔BBS mail forwarding · APRS-over-Meshtastic
connected modes · Neon/PostGIS · multi-region DO sharding + redundant ingest.

---

## 8. Cost (unchanged, committed Tier B)

| Item | Service | $/mo |
|---|---|---|
| Frontend (aprscaching.com) | Cloudflare Pages + custom domain | $0 |
| Workers + DO + D1 + Cron | Workers Paid | $5 |
| Ingest singleton | Fly shared-cpu-1x / Railway / Pi | $2–5 |
| R2 (tiles, audio caches, GPX) | zero egress | ~$1 |
| Domain `aprscaching.com` | registrar (you own it) | ~$1.50 |
| **Total** | | **~$9–13** |

Cost discipline carries over: filter the feed, persist selectively, batch ingest POSTs, hibernate
WS, TTL non-logger positions. **Logger positions get a longer TTL** (needed for verification) — the
one deliberate exception, and it's tiny relative to the firehose.

---

## 9. ⚠️ Regulatory note
Receiving/displaying and logging from received positions needs no license. **Transmitting** (APRS
identity TX-challenge, IGate IS→RF, messaging) requires the operator's own callsign + passcode and
follows local rules (e.g. FCC Part 97). Keep TX off by default and gated.

---

## 10. Decisions that shape the build (please steer)

1. **Legacy data** — do you still have the original socialhams/aprscaching database to migrate
   (caches, logs, accounts)? This decides whether M3 preserves continuity (codes + find history).
2. **Verification strictness** — default policy: do *only* high-trust (RF-corroborated) finds count
   for leaderboards, or do IS-only finds count as "unverified"?
3. **Identity** — APRS message-challenge as primary, with external (QRZ/LoTW) fallback — agree?
4. **Import priority** — OpenCaching first, then SOTA, then POTA? Or lead with SOTA (already on the
   current site)?
5. **MVP find experience** — lead with real-time geofence prompts (M2) or manual log-then-verify
   (M1) as the first shippable "wow"?
