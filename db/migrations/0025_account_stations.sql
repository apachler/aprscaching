-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Operated-stations registry (docs/13 M5 + docs/17). An account owns many stations — a home PWS, a
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
