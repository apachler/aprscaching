-- SR-TRUST-04: a verified find must be idempotent. `cache_logs` had no uniqueness on
-- (cache_id, logger_call) for `found` logs and handleLog did no already-found check, so a racing or
-- replayed POST ran verify + insert + owner-alert + announce + gossip twice and double-counted the
-- find on the leaderboard. This adds the guard the code now relies on (INSERT OR IGNORE + a pre-check).
--
-- Dedup first (keep the earliest found per cache+logger) so the unique index can be created. Safe to
-- collapse in-migration: there is no production data yet. Tier semantics are untouched — this only
-- prevents a *duplicate* found row for the same (cache_id, logger_call).
DELETE FROM cache_logs
WHERE log_type = 'found'
  AND id NOT IN (
    SELECT MIN(id) FROM cache_logs WHERE log_type = 'found' GROUP BY cache_id, logger_call
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_logs_found_unique
  ON cache_logs (cache_id, logger_call)
  WHERE log_type = 'found';
