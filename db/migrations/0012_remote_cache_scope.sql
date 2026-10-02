-- A mirrored cache keeps its origin's federation scope, so an `unlisted` cache stays off this instance's
-- map and offline packs as it does on its origin.
ALTER TABLE remote_caches ADD COLUMN fed_scope TEXT NOT NULL DEFAULT 'public';
