-- The "you're near" radio message: when a player's own station is heard close to a cache, the service call
-- sends it a short APRS message. Opt-in per account, off by default.
ALTER TABLE accounts ADD COLUMN near_radio INTEGER NOT NULL DEFAULT 0;

-- What was sent, for the limits: one message per (person, cache) a day and a few per person an hour. Keyed by
-- the base call, so switching SSIDs does not reset either limit. Rows older than a day are pruned nightly.
CREATE TABLE near_cache_messages (
  call     TEXT NOT NULL,                          -- the base call of the station it went to
  cache_id INTEGER NOT NULL,
  station  TEXT NOT NULL,                          -- the station (with SSID) it went to
  msg_no   TEXT NOT NULL,                          -- its APRS message number on the air
  sent_at  INTEGER NOT NULL,
  acked_at INTEGER,                                -- when the station acknowledged it
  PRIMARY KEY (call, cache_id)
);
CREATE INDEX idx_near_cache_messages_sent ON near_cache_messages (call, sent_at);
