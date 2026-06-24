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
