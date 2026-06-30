-- Bulletin federation (BBS #1): peers exchange bulletins over the signed feed mechanism, deduped by
-- BID. A per-peer cursor makes the bulletin pull incremental, like the cache/find/key feeds.
ALTER TABLE fed_peers ADD COLUMN bulletins_cursor INTEGER NOT NULL DEFAULT 0;
