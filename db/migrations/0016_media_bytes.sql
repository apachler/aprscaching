-- The size of a stage's audio clue, so the media limits (per cache, per account, per instance) count it beside
-- the gallery.
ALTER TABLE cache_stages ADD COLUMN media_bytes INTEGER;
