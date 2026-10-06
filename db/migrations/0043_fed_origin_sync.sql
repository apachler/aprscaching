-- Per-origin federation sync. An instance tracks what it holds of every origin, per record kind, instead of how
-- far it read each neighbour: "every cache of origin Y up to sequence N is here". Any neighbour can then fill
-- the gap after N, and switching paths never reads again what is already held (fedtransit.ts).

-- Each record kind counts up per origin, and that count is the record's signed version `v`: a find's log id, a
-- tombstone's and an account move's seq, and a cache's fed_rev. A cache takes the next number of one counter on
-- every insert and every update, so its fed_rev rises across all the origin's caches, never per row alone. A row
-- inserted with its fed_rev (a backup restored, with the counter beside it) keeps it.
CREATE TABLE fed_cache_rev (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);
INSERT INTO fed_cache_rev (id, n) SELECT 1, COALESCE(MAX(fed_rev), 0) FROM caches;
DROP TRIGGER caches_fed_rev;
CREATE TRIGGER caches_fed_rev_insert AFTER INSERT ON caches
WHEN NEW.fed_rev = 0
BEGIN
  UPDATE fed_cache_rev SET n = n + 1 WHERE id = 1;
  UPDATE caches SET fed_rev = (SELECT n FROM fed_cache_rev WHERE id = 1) WHERE id = NEW.id;
END;
CREATE TRIGGER caches_fed_rev AFTER UPDATE ON caches
WHEN NEW.fed_rev = OLD.fed_rev
BEGIN
  UPDATE fed_cache_rev SET n = n + 1 WHERE id = 1;
  UPDATE caches SET fed_rev = (SELECT n FROM fed_cache_rev WHERE id = 1) WHERE id = NEW.id;
END;
CREATE INDEX idx_caches_fed_rev ON caches (fed_rev);

-- What this instance holds of each origin: for one record kind (cache | find | tombstone | account-move), every
-- record up to `seq` is here, or was superseded or deleted. `region` is the FED_SYNC_REGION a caches mark was read
-- under; '' holds the whole feed and stands for any region.
CREATE TABLE fed_origin_marks (
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  region     TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (origin, kind)
);

-- The frames kept for passing on are served per origin, in the origin's own order; `kind` is the sync type
-- (cache | find | tombstone | account-move).
DROP INDEX idx_fed_transit_seq;
ALTER TABLE fed_transit DROP COLUMN seq;
DROP INDEX idx_fed_transit_origin;
CREATE INDEX idx_fed_transit_origin ON fed_transit (origin, kind, v);
DROP TABLE fed_transit_state;

-- The per-neighbour positions the marks replace. Keys and bulletins keep their per-peer cursors.
ALTER TABLE fed_peers DROP COLUMN caches_cursor;
ALTER TABLE fed_peers DROP COLUMN caches_cursor_id;
ALTER TABLE fed_peers DROP COLUMN caches_region;
ALTER TABLE fed_peers DROP COLUMN finds_cursor;
ALTER TABLE fed_peers DROP COLUMN tombstones_cursor;
ALTER TABLE fed_peers DROP COLUMN moves_cursor;
ALTER TABLE fed_peers DROP COLUMN transit_cursor;
ALTER TABLE fed_peers DROP COLUMN transit_region;
