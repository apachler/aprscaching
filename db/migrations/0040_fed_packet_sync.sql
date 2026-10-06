-- Federation pull over packet circuits: the ingest box dials a peer's ax25 or netrom endpoint, hands each page
-- to /federation/frames and reports the session here, one row per peer instance. The cursors belong to this
-- path alone, so the packet pull and the HTTP pull never move each other's position; a record that arrives
-- both ways applies once, by its version.
CREATE TABLE fed_packet_sync (
  instance     TEXT PRIMARY KEY,
  transport    TEXT,                        -- ax25 | netrom, the endpoint of the last session
  address      TEXT,
  last_attempt INTEGER,
  last_ok      INTEGER,
  last_error   TEXT,
  sessions_ok  INTEGER NOT NULL DEFAULT 0,
  sessions_err INTEGER NOT NULL DEFAULT 0,
  last_counts  TEXT,                        -- JSON {pages, frames, applied, quarantined, rejected, complete}
  cursors      TEXT                         -- JSON {feed: {since, sinceId?}}
);
