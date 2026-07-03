-- SR-RT-07: the nightly firehose TTL (`DELETE FROM positions WHERE source='firehose' AND ts<?`)
-- had no usable index and full-scanned the largest table in the schema — on the synchronous
-- better-sqlite3 runtime that stalls the whole event loop once positions grows. This index makes
-- the prune (and any source+time query) a range scan; the delete itself is batched in app.ts.
CREATE INDEX IF NOT EXISTS idx_pos_source_ts ON positions (source, ts);
