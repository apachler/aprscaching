-- Records a hub passes on. Every cache, find and tombstone mirrored from another instance keeps the frame its
-- origin signed, byte for byte, so this instance can serve it again on the transit feed (fedtransit.ts) without
-- re-signing it: a receiver verifies it against the origin's key and applies the origin's trust.
CREATE TABLE fed_transit (
  gid         TEXT PRIMARY KEY,                    -- the record's global id, in its origin's namespace
  origin      TEXT NOT NULL,                       -- the instance that signed it
  kind        TEXT NOT NULL,                       -- cache | find | tombstone
  v           INTEGER NOT NULL,                    -- the version held, the one the frame carries
  frame       BLOB NOT NULL,                       -- the signed fedwire frame, verbatim
  signer_key  TEXT NOT NULL,                       -- the origin key the frame verified under
  via         TEXT NOT NULL,                       -- the instance that delivered it here (the origin itself when direct)
  hops        INTEGER NOT NULL,                    -- instances crossed to reach here: 1 straight from the origin
  target      TEXT,                                -- a tombstone's target global id
  scope       TEXT,                                -- a cache's fed_scope
  lat         REAL,                                -- a cache's position, for a region-filtered pull
  lon         REAL,
  seq         INTEGER NOT NULL,                    -- the transit feed cursor; a newer version moves to the end
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_fed_transit_seq ON fed_transit (seq);
CREATE INDEX idx_fed_transit_origin ON fed_transit (origin);

-- The transit feed cursor per peer, and the region it was read under ('' for the whole feed).
ALTER TABLE fed_peers ADD COLUMN transit_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fed_peers ADD COLUMN transit_region TEXT NOT NULL DEFAULT '';
-- The peer's rotation records (JSON), kept so a hub can hand them on with the peer's key: an instance that
-- learns the peer through the hub follows its key along the same verified chain.
ALTER TABLE fed_peers ADD COLUMN rotations TEXT;
