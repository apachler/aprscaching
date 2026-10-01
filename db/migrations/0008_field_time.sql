-- A log's find time (cache_logs.ts) is its signed field time when the signature's time passes the bounds
-- (workers/gateway/src/fieldtime.ts), so a find queued offline is verified at the moment it was made.
-- received_at is when the gateway received the log; field_time_rejected says why ts is the receive time
-- instead: future | too_old | before_cache | before_key | unsigned (an unsigned log the client queued).
ALTER TABLE cache_logs ADD COLUMN received_at INTEGER;
ALTER TABLE cache_logs ADD COLUMN field_time_rejected TEXT;
