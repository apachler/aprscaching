-- aprscaching.com — D1 schema (SQLite)
-- Greenfield. APRS Caching is the core; positions power presence verification.

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

------------------------------------------------------------ SOCIAL / GAMIFY
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
