-- Per-origin federation sync. An instance tracks what it holds of every origin, per record kind, instead of how
-- far it read each neighbour: "every cache of origin Y up to sequence N is here". Any neighbour can then fill
-- the gap after N, and switching paths never reads again what is already held (fedtransit.ts).

-- Each record kind counts up per origin, and that count is the record's signed version `v`: a cache's fed_rev
-- and the fed_seq of a find, a tombstone and an account move. Every insert (and every update of a cache) takes
-- the next number of its kind's counter, at least the current time in milliseconds: a database restored from an
-- older backup carries an older counter, and the time floor still puts its new records above every number it
-- handed out before. A row inserted with its number (a backup restored, with the counter beside it) keeps it.
-- The number is also the record's global id (`<instance>:cache:<fed_id>`, `…:find:<fed_seq>`, …): row ids come
-- back with a backup and are handed out again, sequence numbers are not, so a new record never takes the global id
-- of one the peers hold or deleted. A cache keeps the number it was made with in `fed_id`.
CREATE TABLE fed_seq (
  kind TEXT PRIMARY KEY,                           -- cache | find | tombstone | account-move | key
  n    INTEGER NOT NULL
);
INSERT INTO fed_seq (kind, n) SELECT 'cache', MAX(COALESCE(MAX(fed_rev), 0), COALESCE(MAX(id), 0)) FROM caches;
INSERT INTO fed_seq (kind, n) SELECT 'find', COALESCE(MAX(id), 0) FROM cache_logs;
INSERT INTO fed_seq (kind, n) SELECT 'tombstone', COALESCE(MAX(seq), 0) FROM tombstones;
INSERT INTO fed_seq (kind, n) SELECT 'account-move', COALESCE(MAX(seq), 0) FROM account_moves;
INSERT INTO fed_seq (kind, n) SELECT 'key', COALESCE(MAX(id), 0) FROM callsign_keys;

ALTER TABLE caches ADD COLUMN fed_id INTEGER NOT NULL DEFAULT 0;
UPDATE caches SET fed_id = id;
DROP TRIGGER caches_fed_rev;
CREATE TRIGGER caches_fed_rev_insert AFTER INSERT ON caches
WHEN NEW.fed_rev = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'cache';
  UPDATE caches SET fed_rev = (SELECT n FROM fed_seq WHERE kind = 'cache'),
                    fed_id = CASE WHEN NEW.fed_id = 0 THEN (SELECT n FROM fed_seq WHERE kind = 'cache') ELSE NEW.fed_id END
   WHERE id = NEW.id;
END;
CREATE TRIGGER caches_fed_rev AFTER UPDATE ON caches
WHEN NEW.fed_rev = OLD.fed_rev
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'cache';
  UPDATE caches SET fed_rev = (SELECT n FROM fed_seq WHERE kind = 'cache') WHERE id = NEW.id;
END;
CREATE INDEX idx_caches_fed_rev ON caches (fed_rev);
CREATE INDEX idx_caches_fed_id ON caches (fed_id);

ALTER TABLE cache_logs ADD COLUMN fed_seq INTEGER NOT NULL DEFAULT 0;
UPDATE cache_logs SET fed_seq = id;
CREATE TRIGGER cache_logs_fed_seq AFTER INSERT ON cache_logs
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'find';
  UPDATE cache_logs SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'find') WHERE id = NEW.id;
END;
CREATE INDEX idx_cache_logs_fed_seq ON cache_logs (fed_seq);

ALTER TABLE tombstones ADD COLUMN fed_seq INTEGER NOT NULL DEFAULT 0;
UPDATE tombstones SET fed_seq = seq;
CREATE TRIGGER tombstones_fed_seq AFTER INSERT ON tombstones
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'tombstone';
  UPDATE tombstones SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'tombstone') WHERE seq = NEW.seq;
END;
CREATE INDEX idx_tombstones_fed_seq ON tombstones (fed_seq);

ALTER TABLE account_moves ADD COLUMN fed_seq INTEGER NOT NULL DEFAULT 0;
UPDATE account_moves SET fed_seq = seq;
CREATE TRIGGER account_moves_fed_seq AFTER INSERT ON account_moves
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'account-move';
  UPDATE account_moves SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'account-move') WHERE seq = NEW.seq;
END;
CREATE INDEX idx_account_moves_fed_seq ON account_moves (fed_seq);

-- Callsign keys travel per peer, not per origin, but number the same way: the keys cursor pages by fed_seq, and the
-- key's global id is `<instance>:key:<fed_seq>`, so a key registered after a restore reaches every peer.
ALTER TABLE callsign_keys ADD COLUMN fed_seq INTEGER NOT NULL DEFAULT 0;
UPDATE callsign_keys SET fed_seq = id;
CREATE TRIGGER callsign_keys_fed_seq AFTER INSERT ON callsign_keys
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'key';
  UPDATE callsign_keys SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'key') WHERE id = NEW.id;
END;
CREATE INDEX idx_callsign_keys_fed_seq ON callsign_keys (fed_seq);

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
-- How far this instance has read one neighbour's pages of one origin and kind, held or not: it asks that
-- neighbour again only past this, unless the neighbour holds the origin whole beyond this instance's mark.
CREATE TABLE fed_read_positions (
  via      TEXT NOT NULL,
  origin   TEXT NOT NULL,
  kind     TEXT NOT NULL,
  region   TEXT NOT NULL DEFAULT '',
  seq      INTEGER NOT NULL,
  -- the neighbour's `held` this instance last read its pages again from the mark for, so it does that once per
  -- value of `held`, never at every pass
  replayed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (via, origin, kind, region)
);
-- Records of an origin this instance knows it does not hold whole, though its mark has moved past them: one that
-- did not settle (a frame signed ahead of this clock, one the database could not take, one that did not verify),
-- one kept past the hop limit, or one a neighbour said it lacks. Each is asked for again on its own, from every
-- neighbour, backing off per neighbour (`tries`, JSON {via: [attempts, next unix second]}).
CREATE TABLE fed_origin_gaps (
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  reason     TEXT NOT NULL,                      -- unsettled | upstream | hops | upstream-hops
  first_seen INTEGER NOT NULL,
  tries      TEXT NOT NULL DEFAULT '{}',
  attempts   INTEGER NOT NULL DEFAULT 0,         -- failed asks, from every neighbour together
  PRIMARY KEY (origin, kind, v)
);
-- Gaps no neighbour filled within 7 days and 5 asks: given up, so the marks move past them, and listed for the
-- sysop until marked seen; a row seen 30 days ago goes. A record past the hop limit (`hops`, `upstream-hops`) is no
-- fault anyone can fix but by a shorter path: its gap goes silently after 30 days.
CREATE TABLE fed_gaps_given_up (
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  given_up   INTEGER NOT NULL,
  seen_at    INTEGER,
  PRIMARY KEY (origin, kind, v)
);
-- A spoke's push of one feed went back once to where its hub held it whole: not again to the same place.
ALTER TABLE fed_push_cursors ADD COLUMN rewound_to INTEGER;
-- Counts up whenever what this instance held of an origin is forgotten (its records dropped with a key a
-- neighbour handed on), so a pull already under way for the origin moves no mark afterwards.
CREATE TABLE fed_mark_gen (
  origin TEXT PRIMARY KEY,
  gen    INTEGER NOT NULL
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

-- Cache versions counted from 2^32 and caches feeds paged by time: what a mirror applied under them, and where
-- a push or a packet session stopped in a caches feed, starts over, so no cache is refused or skipped.
DELETE FROM fed_versions WHERE gid LIKE '%:cache:%' AND v >= 4294967296 AND v < 1000000000000;
UPDATE remote_tombstones SET up_to = up_to - 4294967296 WHERE up_to >= 4294967296 AND up_to < 1000000000000;
UPDATE tombstones SET up_to = up_to - 4294967296 WHERE up_to >= 4294967296 AND up_to < 1000000000000;
DELETE FROM fed_transit WHERE kind = 'cache' AND v >= 4294967296 AND v < 1000000000000;
DELETE FROM fed_push_cursors WHERE type = 'cache';
DELETE FROM fed_submit_marks WHERE type = 'cache';
UPDATE fed_packet_sync SET cursors = json_remove(cursors, '$.cache') WHERE cursors IS NOT NULL;
