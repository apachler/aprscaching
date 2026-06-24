-- 0006: import / heritage (M3). Imported caches carry a source attribution + deep link, and
-- re-importing updates in place (dedup on source + external_id).

ALTER TABLE caches ADD COLUMN source_url  TEXT;     -- deep link to the source's page for this item
ALTER TABLE caches ADD COLUMN source_name TEXT;     -- human attribution label, e.g. "SOTA", "Opencaching.de"
ALTER TABLE caches ADD COLUMN imported_at INTEGER;  -- last time this row was (re)imported

-- one row per (source, external_id) => re-imports update instead of duplicating
CREATE UNIQUE INDEX idx_caches_external ON caches(source, external_id) WHERE external_id IS NOT NULL;
