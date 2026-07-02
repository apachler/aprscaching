-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0001 core  —  consolidated initial schema (part 1 of 4)
-- Caching & APRS core — caches, logs, positions, stations, sensors, messages; accounts &
-- auth (passkeys + APRS-message verification); the first federation mirror; corroboration;
-- per-operator signing keys; heritage imports; multi-stage caches; the store-and-forward BBS base.
-- Squashed baseline: greenfield deploys create the whole schema from these four files.

-- ─── init ───
-- aprscaching.com — D1 schema (SQLite)
-- Greenfield. APRScaching is the core; positions power presence verification.

------------------------------------------------------------------- IDENTITY
CREATE TABLE accounts (
  callsign      TEXT PRIMARY KEY,
  verified      INTEGER NOT NULL DEFAULT 0,
  verify_method TEXT,                       -- aprs_msg | aprs_tx | external
  verified_at   INTEGER,
  display_name  TEXT,
  home_grid     TEXT,
  created_at    INTEGER NOT NULL
);

--------------------------------------------------------------------- CACHES
CREATE TABLE caches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,         -- AC-1234 (native) or imported code
  owner_call  TEXT NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL,                -- single | two_stage | multi | aprs_living | audio | traditional | sota | pota
  status      TEXT NOT NULL DEFAULT 'active', -- active | disabled | archived
  difficulty  REAL DEFAULT 1.5,             -- 1.0..5.0
  terrain     REAL DEFAULT 1.5,             -- 1.0..5.0
  lat         REAL,                         -- final coords (or stage-1 for staged)
  lon         REAL,
  station_call TEXT,                        -- aprs_living: the beaconing station that IS the cache
  source      TEXT NOT NULL DEFAULT 'native', -- native | opencaching | sota | pota
  external_id TEXT,                         -- OC code / SOTA ref / POTA ref
  hint        TEXT,
  description TEXT,
  -- per-cache verification override (NULL = use site policy)
  min_trust   TEXT,                         -- A | B | NULL
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- spatial lookup for "caches in a bbox" / geofence loading.
-- NB: Cloudflare D1 does not allow CREATE VIRTUAL TABLE (rtree/fts), so we use a plain
-- lat/lon index. A range scan on lat + lon filter is plenty for M1/M2 cache volumes.
CREATE INDEX idx_caches_geo ON caches(lat, lon);
CREATE INDEX idx_caches_status ON caches(status);

CREATE TABLE cache_stages (
  cache_id  INTEGER NOT NULL,
  stage_no  INTEGER NOT NULL,
  lat       REAL, lon REAL,
  clue      TEXT,
  unlock    TEXT,                           -- coords | audio | puzzle
  PRIMARY KEY (cache_id, stage_no)
);

----------------------------------------------------------------------- LOGS
CREATE TABLE cache_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id      INTEGER NOT NULL,
  logger_call   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  log_type      TEXT NOT NULL,              -- found | dnf | note | maintenance | enabled | disabled
  verified      INTEGER NOT NULL DEFAULT 0,
  tier          TEXT,                       -- A | B | C
  verify_method TEXT,                       -- aprs_rf | app_geo | aprs_is | manual | none
  matched_position_id INTEGER,
  distance_m    REAL,
  comment       TEXT
);
CREATE INDEX idx_logs_cache ON cache_logs(cache_id, ts DESC);
CREATE INDEX idx_logs_logger ON cache_logs(logger_call, ts DESC);

----------------------------------------------- POSITION HISTORY (verification)
-- Logger positions kept longer than the firehose TTL so a find can be verified.
CREATE TABLE positions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  heard_via  TEXT NOT NULL,                 -- rf | aprs_is   (from q-construct)
  igate_call TEXT,                          -- the gating IGate (for independence checks)
  path       TEXT,
  source     TEXT                           -- app_geo positions land here too (heard_via='app')
);
CREATE INDEX idx_pos_call_ts ON positions(callsign, ts DESC);

--------------------------------------------------------- COMMUNITY / GAMIFY
CREATE TABLE achievements (callsign TEXT, badge TEXT, earned_at INTEGER, PRIMARY KEY (callsign, badge));
CREATE TABLE favorites    (callsign TEXT, cache_id INTEGER, PRIMARY KEY (callsign, cache_id));
CREATE TABLE watches      (callsign TEXT, cache_id INTEGER, PRIMARY KEY (callsign, cache_id));

------------------------------------------------ WORKBENCH (platform, minimal)
CREATE TABLE stations (
  callsign TEXT PRIMARY KEY, ssid INTEGER, symbol TEXT,
  lat REAL, lon REAL, last_seen INTEGER,
  course INTEGER, speed_kn INTEGER, altitude_m INTEGER,
  status_color TEXT, comment TEXT, source_call TEXT
);
CREATE INDEX idx_stations_geo ON stations(lat, lon);

CREATE TABLE sensor_readings (
  station TEXT, ts INTEGER, temp_c REAL, humidity REAL, pressure_hpa REAL,
  wind_dir INTEGER, wind_kn REAL, rain_mm REAL, PRIMARY KEY (station, ts)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER,
  from_call TEXT, to_call TEXT, body TEXT, ack TEXT, direction TEXT
);

CREATE TABLE port_stats (port TEXT, ts INTEGER, rx INTEGER, tx INTEGER, PRIMARY KEY (port, ts));

-- ─── auth announce ───
-- 0002_auth_announce.sql
-- Auth layer (passkey identity + async callsign-control badge) and the APRS-IS announce outbox.

-------------------------------------------------- IDENTITY: passkeys (WebAuthn)
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,        -- credential ID (base64url)
  callsign    TEXT NOT NULL,
  public_key  BLOB NOT NULL,
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_cred_callsign ON credentials(callsign);

-- short-lived challenges for passkey ceremonies AND magic-links / APRS codes
CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  callsign    TEXT,
  kind        TEXT NOT NULL,           -- webauthn_reg | webauthn_login | magic | aprs_code
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

------------------------------------- CALLSIGN-CONTROL VERIFICATION (the badge)
-- Async; NEVER blocks logging. Gates the APRS-IS announce feature + competitive credit.
CREATE TABLE callsign_verifications (
  callsign    TEXT PRIMARY KEY,
  method      TEXT,                    -- aprs_msg | aprs_tx | lotw | qrz | external
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | verified | failed
  challenge   TEXT,                    -- one-time code we sent / token to TX
  verified_at INTEGER
);

-------------------------------------------------- ACCOUNT FLAGS (added to 0001)
ALTER TABLE accounts ADD COLUMN announce_is INTEGER NOT NULL DEFAULT 0; -- opt-in: publish finds to APRS-IS
ALTER TABLE accounts ADD COLUMN announce_tocall TEXT DEFAULT 'APZACG';  -- experimental tocall until registered

------------------------------------------------------------ APRS-IS OUTBOX
-- Worker enqueues; the ingest box (only holder of the APRS-IS uplink) publishes via
-- third-party format. Excluded from verification by construction (status, not position).
CREATE TABLE aprs_outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  src_call  TEXT NOT NULL,             -- the user's VERIFIED callsign (inner source)
  tocall    TEXT NOT NULL DEFAULT 'APZACG',
  kind      TEXT NOT NULL,             -- status | message
  payload   TEXT NOT NULL,             -- e.g. ">Found AC-1234 (Reutersley) via aprscaching.com"
  status    TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  sent_at   INTEGER
);
CREATE INDEX idx_outbox_status ON aprs_outbox(status, ts);

-- ─── federation mirror ───
-- 0003: federation mirror (F2) — peers we pull from, and the records we mirror locally.
-- Mirrored rows are display-only: never treated as our own, never re-published in our feeds.

CREATE TABLE fed_peers (
  url           TEXT PRIMARY KEY,        -- base URL of the peer instance
  instance      TEXT,                    -- discovered instance id (from /.well-known)
  public_key    TEXT,                    -- discovered Ed25519 public key (raw, base64url)
  caches_cursor INTEGER NOT NULL DEFAULT 0,
  finds_cursor  INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sync     INTEGER,
  last_error    TEXT
);

CREATE TABLE remote_caches (
  global_id    TEXT PRIMARY KEY,         -- e.g. oe.aprscaching.org:cache:42
  origin       TEXT NOT NULL,            -- originating instance id
  code         TEXT, owner_call TEXT, title TEXT, type TEXT, status TEXT,
  difficulty   REAL, terrain REAL, lat REAL, lon REAL,
  station_call TEXT, source TEXT, external_id TEXT, hint TEXT, description TEXT, min_trust TEXT,
  created_at   INTEGER, updated_at INTEGER,
  mirrored_at  INTEGER NOT NULL
);
CREATE INDEX idx_remote_caches_geo ON remote_caches(lat, lon);

CREATE TABLE remote_finds (
  global_id       TEXT PRIMARY KEY,      -- e.g. oe...:find:99
  origin          TEXT NOT NULL,
  cache_global_id TEXT, cache_code TEXT,
  logger_call     TEXT, ts INTEGER, log_type TEXT,
  verified        INTEGER, tier TEXT, verify_method TEXT, distance_m REAL, comment TEXT,
  mirrored_at     INTEGER NOT NULL
);
CREATE INDEX idx_remote_finds_cache ON remote_finds(cache_global_id);

-- ─── corroboration ───
-- 0004: cross-instance verification (F3). Record which peer corroborated a Tier-A find via RF.
ALTER TABLE cache_logs ADD COLUMN corroborated_by TEXT;

-- ─── callsign keys ───
-- 0005: per-callsign signing (F0). Device keys bound to callsigns; finds carry the logger's signature.

CREATE TABLE callsign_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  public_key TEXT NOT NULL,               -- Ed25519 raw, base64url
  label      TEXT,
  verified   INTEGER NOT NULL DEFAULT 0,  -- callsign badge-verified at registration time
  created_at INTEGER NOT NULL,
  UNIQUE (callsign, public_key)
);
CREATE INDEX idx_callsign_keys_call ON callsign_keys(callsign);

-- a find may be signed by the logger's device key (provenance, portable across instances)
ALTER TABLE cache_logs ADD COLUMN signer_key TEXT;   -- the device public key (base64url)
ALTER TABLE cache_logs ADD COLUMN author_sig TEXT;   -- signature over authorshipMessage(...)
ALTER TABLE cache_logs ADD COLUMN signed_at  INTEGER;-- client authorship time the signature covers

-- mirrored key bindings from peers (so consumers can check author signatures offline)
CREATE TABLE remote_keys (
  global_id   TEXT PRIMARY KEY,           -- origin:key:rowid
  origin      TEXT NOT NULL,
  callsign    TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  verified    INTEGER, created_at INTEGER, mirrored_at INTEGER NOT NULL
);
CREATE INDEX idx_remote_keys_call ON remote_keys(callsign);

-- per-feed cursor for the keys feed
ALTER TABLE fed_peers ADD COLUMN keys_cursor INTEGER NOT NULL DEFAULT 0;

-- ─── imports ───
-- 0006: import / heritage (M3). Imported caches carry a source attribution + deep link, and
-- re-importing updates in place (dedup on source + external_id).

ALTER TABLE caches ADD COLUMN source_url  TEXT;     -- deep link to the source's page for this item
ALTER TABLE caches ADD COLUMN source_name TEXT;     -- human attribution label, e.g. "SOTA", "Opencaching.de"
ALTER TABLE caches ADD COLUMN imported_at INTEGER;  -- last time this row was (re)imported

-- one row per (source, external_id) => re-imports update instead of duplicating
CREATE UNIQUE INDEX idx_caches_external ON caches(source, external_id) WHERE external_id IS NOT NULL;

-- ─── stages ───
-- M2 audio-cache: extend the cache_stages scaffold from 0001 (cache_id, stage_no, lat, lon,
-- clue, unlock) with an audio-clue media key + a per-stage geofence radius, and add the
-- per-finder unlock ledger. Stage 0 is the public start; later stages reveal once the finder
-- unlocks the prior stage (a geofence at it, or after its audio clue).
ALTER TABLE cache_stages ADD COLUMN media_key TEXT;
ALTER TABLE cache_stages ADD COLUMN radius_m INTEGER NOT NULL DEFAULT 60;

CREATE TABLE stage_unlocks (
  callsign    TEXT NOT NULL,
  cache_id    INTEGER NOT NULL,
  stage_no    INTEGER NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (callsign, cache_id, stage_no)
);

-- ─── account lifecycle ───
-- Account data lifecycle: a small ledger of erasures and migrations. Used to honour GDPR
-- right-to-erasure (tombstone) and account portability across federation peers, and to drive
-- redirects ("this callsign moved to <instance>") + downstream mirror purges.
CREATE TABLE account_events (
  callsign TEXT NOT NULL,
  action   TEXT NOT NULL,          -- 'deleted' | 'moved'
  detail   TEXT,                   -- e.g. target instance for a move
  at       INTEGER NOT NULL,
  PRIMARY KEY (callsign, action)
);

-- ─── bbs ───
-- BBS store-and-forward message base (Stage 1: connectionless / APRS-message delivery).
-- Personal mail is held until the addressee is heard, then forwarded as an APRS message with
-- ack tracking + retry. Bulletins are retrievable and deduped by BID across forwarding. The
-- format (P/B type, BID) is MBL/FBB-compatible so a future connected-mode gateway can bridge.
CREATE TABLE bbs_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bid        TEXT UNIQUE,                       -- e.g. "42_oe.aprscaching.org" — dedup across peers
  type       TEXT NOT NULL,                     -- 'P' personal | 'B' bulletin
  from_call  TEXT NOT NULL,
  to_call    TEXT NOT NULL,                     -- callsign (P) or category e.g. ALL / SYSOP (B)
  subject    TEXT,
  body       TEXT NOT NULL,
  posted_at  INTEGER NOT NULL,
  expires_at INTEGER,
  origin     TEXT NOT NULL DEFAULT 'local',     -- 'local' or the instance id a bulletin forwarded from
  read_at    INTEGER                            -- personal: when the recipient read it (web)
);
CREATE INDEX idx_bbs_to ON bbs_messages(to_call, type, posted_at DESC);

-- Per-recipient delivery state for the store-and-forward (APRS) path.
CREATE TABLE bbs_delivery (
  msg_id       INTEGER NOT NULL,
  to_call      TEXT NOT NULL,
  line_no      INTEGER,                          -- the APRS message number {NN used on the wire
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  acked_at     INTEGER,
  status       TEXT NOT NULL DEFAULT 'held',     -- held | sent | acked | expired
  PRIMARY KEY (msg_id, to_call)
);
CREATE INDEX idx_bbs_delivery_call ON bbs_delivery(to_call, status);
