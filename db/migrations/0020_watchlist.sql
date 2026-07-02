-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Watchlist alerts (docs/20 §4, W1; extends docs/11 / ADR-4b). Watch callsigns per ACCOUNT (survives
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
