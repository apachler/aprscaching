-- A found log that missed Tier A only because trusted peers could not be reached is asked again: the same
-- question, to those peers only, a few times within 72 hours (corroborate_retry.ts). A row goes when the
-- find reaches Tier A, a peer says no, the attempts run out, or its log goes.
CREATE TABLE corroboration_retries (
  log_id    INTEGER PRIMARY KEY REFERENCES cache_logs(id) ON DELETE CASCADE,
  query     TEXT NOT NULL,  -- JSON CorroborationQuery, asked again verbatim
  peers     TEXT NOT NULL,  -- JSON [url]: the trusted peers not reached last time
  hits      TEXT NOT NULL,  -- JSON [{url, ev}]: trusted evidence already in hand
  logged_at INTEGER NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0,
  next_at   INTEGER NOT NULL
);
CREATE INDEX idx_corr_retry_next ON corroboration_retries(next_at);

-- When a find reached Tier A through a later attempt; NULL for a find settled when it was logged.
ALTER TABLE cache_logs ADD COLUMN corroborated_later_at INTEGER;
