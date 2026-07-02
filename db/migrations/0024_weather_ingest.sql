-- SPDX-License-Identifier: AGPL-3.0-or-later
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
