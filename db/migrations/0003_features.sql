-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0003 features  —  consolidated initial schema (part 3 of 4)
-- User features & the workbench data plane — remote box command channel, watchlist alerts,
-- saved map views, web-push subscriptions, opt-in ham profile, weather ingest + WX TX, the user's
-- own station registry, and the cross-instance corroborator credit.
-- Squashed baseline: greenfield deploys create the whole schema from these four files.

-- ─── box commands ───
-- Remote station control: a per-box command queue the operator's ingest box pulls
-- over its existing outbound connection (no inbound ports). TX-capable commands are control-verified
-- (H5); RX-only boxes only ever receive read commands. Distinct from federation peer identity.
CREATE TABLE IF NOT EXISTS box_commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id     TEXT NOT NULL,
  callsign   TEXT,                              -- licensed call the command operates as (TX → must be verified)
  kind       TEXT NOT NULL,                     -- beacon | message | wx_beacon | igate | digi | tx | status
  payload    TEXT,                              -- JSON command args
  status     TEXT NOT NULL DEFAULT 'queued',    -- queued | sent | done | failed
  result     TEXT,                              -- box-reported result/error
  sig        TEXT,                              -- optional Ed25519 signature for the licensed call (box-verified)
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  acked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_box_commands_poll ON box_commands (box_id, status, created_at);

-- ─── watchlist ───
-- Watchlist alerts. Watch callsigns per ACCOUNT (survives
-- callsign changes, ADR-2); raise an in-app alert when a watched call is heard on the network or heard
-- near a cache. Push/email delivery is the ADR-4b layer on top; this is the in-app fallback + store.
CREATE TABLE IF NOT EXISTS watch_calls (
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,                 -- base call (no SSID)
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, callsign)
);
CREATE INDEX IF NOT EXISTS idx_watch_calls_call ON watch_calls (callsign);

CREATE TABLE IF NOT EXISTS watch_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- heard | near_cache
  detail     TEXT,
  cache_id   INTEGER,
  lat        REAL,
  lon        REAL,
  ts         INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_acct ON watch_alerts (account_id, ts);

-- ─── saved views ───
-- Save / share map views: a permalink short-link that restores a map state
-- (centre/zoom/layers/filters/selection). Public by default — the point is to share a link.
CREATE TABLE IF NOT EXISTS saved_views (
  slug       TEXT PRIMARY KEY,
  owner_call TEXT,
  name       TEXT,
  state      TEXT NOT NULL,                 -- JSON: { center, zoom, layers, filters, selected }
  public     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_views_owner ON saved_views (owner_call);

-- ─── notifications ───
-- Push + email-digest delivery (ADR-4b M4). Web-push subscriptions (the enhancement) and
-- the email digest of unseen watch alerts (the MANDATORY fallback). In-app alerts already exist (W1).
CREATE TABLE IF NOT EXISTS push_subs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT,
  auth       TEXT,
  topics     TEXT,                              -- comma list: nearby | new_cache | watch
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, endpoint)
);
-- track which alerts have already gone out in a digest (so we never re-send)
ALTER TABLE watch_alerts ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
-- per-account email-digest opt-out (default on — it's the iOS/no-push fallback)
ALTER TABLE accounts ADD COLUMN notify_digest INTEGER NOT NULL DEFAULT 1;

-- ─── profile ───
-- Thin, opt-in ham profile. display_name + home_grid already exist (0001); add the rest.
-- All fields are opt-in and self-curated; they live inside the existing GDPR export/erase.
ALTER TABLE accounts ADD COLUMN avatar_url     TEXT;     -- opt-in image URL
ALTER TABLE accounts ADD COLUMN bio            TEXT;     -- short plain text, length-capped + tag-stripped server-side
ALTER TABLE accounts ADD COLUMN links          TEXT;     -- JSON [{label,url}], http(s) only, capped count
ALTER TABLE accounts ADD COLUMN public_contact TEXT;     -- opt-in public email; NULL = not shown (account email stays private)
ALTER TABLE accounts ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 1; -- master show/hide

-- ─── weather ingest ───
-- Weather user-origination: a PWS pushes directly to the platform, stored in
-- sensor_readings under the user's -13 weather SSID. Extend the reading to the fuller APRS field set
-- (rain_mm stays = last-hour for back-compat) and add per-user push keys.
ALTER TABLE sensor_readings ADD COLUMN gust_kn        REAL;
ALTER TABLE sensor_readings ADD COLUMN rain_24h_mm    REAL;
ALTER TABLE sensor_readings ADD COLUMN rain_mid_mm    REAL;   -- since local midnight
ALTER TABLE sensor_readings ADD COLUMN luminosity_wm2 REAL;
ALTER TABLE sensor_readings ADD COLUMN snow_mm        REAL;
ALTER TABLE sensor_readings ADD COLUMN source         TEXT;   -- rf | aprs_is | ecowitt | wu | serial | cwop

CREATE TABLE IF NOT EXISTS wx_keys (
  key        TEXT PRIMARY KEY,
  callsign   TEXT NOT NULL,             -- base call; readings land under <call>-13
  account_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wx_keys_call ON wx_keys (callsign);

-- ─── account stations ───
-- Operated-stations registry. An account owns many stations — a home PWS, a
-- mountain-top digipeater / igate / node — each with its own callsign+SSID, an EXPLICIT location
-- (not just the operator's home grid), a description and roles. Weather is one capability among
-- several; a weather-capable station carries its own PWS push key (wx_keys.station_id).
CREATE TABLE IF NOT EXISTS account_stations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  callsign    TEXT NOT NULL,              -- full callsign incl. SSID, e.g. OE8APR-1
  lat         REAL,
  lon         REAL,
  symbol      TEXT,                       -- APRS symbol char (role default if unset)
  description TEXT,
  roles       TEXT NOT NULL DEFAULT '',   -- csv subset of: weather,digipeater,igate,node,relay
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_stations_call ON account_stations (callsign);
CREATE INDEX IF NOT EXISTS idx_account_stations_acct ON account_stations (account_id);

-- A weather push key now feeds a specific station row (null = legacy <call>-13 home PWS).
ALTER TABLE wx_keys ADD COLUMN station_id INTEGER;

-- ─── corroborator igate ───
-- Cross-instance corroborator credit. Persist the IGate that corroborated each
-- Tier-A find directly on the log, so the corroborator leaderboard credits the operator who actually
-- did the RF corroboration — whether it happened on THIS instance (the matched position's gating
-- IGate) or on a federated peer that revealed its IGate (FED_REVEAL_IGATE, both-opt-in). Peer-
-- corroborated finds previously had no matched_position_id and so earned no IGate credit.
ALTER TABLE cache_logs ADD COLUMN corroborator_igate TEXT;

CREATE INDEX IF NOT EXISTS idx_logs_corroborator ON cache_logs (corroborator_igate);

-- ─── weather tx ───
-- Weather TX. Per-PWS opt-in flags (off by default,
-- gated on a control-verified callsign) and a beacon throttle, plus an outbox target so the ingest
-- box routes a queued WX report to standard APRS-IS (W2) or to CWOP/NOAA (W3).
ALTER TABLE wx_keys ADD COLUMN tx_is       INTEGER NOT NULL DEFAULT 0;  -- W2: beacon to APRS-IS
ALTER TABLE wx_keys ADD COLUMN tx_cwop     INTEGER NOT NULL DEFAULT 0;  -- W3: relay to CWOP (NOAA)
ALTER TABLE wx_keys ADD COLUMN last_beacon INTEGER;                     -- throttle (epoch s)

ALTER TABLE aprs_outbox ADD COLUMN target TEXT NOT NULL DEFAULT 'is';   -- is | cwop  (drain routing)
