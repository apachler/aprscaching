-- SPDX-License-Identifier: AGPL-3.0-or-later
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
