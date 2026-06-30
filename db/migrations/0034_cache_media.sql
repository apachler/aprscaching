-- Cache media attachments (docs/26 F-3): the original APRSCaching let owners attach photos, audio and
-- data files (hints, circuit diagrams, the audio sample) to a cache. Stored in the MEDIA object store
-- (R2 on CF, filesystem on Node/Bun) like the stage clues; this table is the per-cache index. Owner-
-- managed, size/type-limited at the handler. All three runtimes.
CREATE TABLE cache_media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id     INTEGER NOT NULL,
  media_key    TEXT NOT NULL,             -- object-store key
  kind         TEXT NOT NULL,             -- image | audio | file
  content_type TEXT NOT NULL,
  title        TEXT,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_cache_media_cache ON cache_media (cache_id);
