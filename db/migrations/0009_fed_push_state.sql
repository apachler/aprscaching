-- Push-to-hub state that survives a restart.
--
-- On a spoke: how far each feed has been pushed to the hub (advanced only after the hub's 2xx, so a
-- restart resumes instead of pushing everything again), and how the last push went, for the operator's
-- view and for the reconnect probe.
CREATE TABLE fed_push_cursors (
  hub        TEXT NOT NULL,
  type       TEXT NOT NULL,                 -- the feed: tombstone | cache | find | key
  cursor     INTEGER NOT NULL,
  cursor_id  INTEGER,                       -- the id tie-breaker of a composite feed, mid-pass
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (hub, type)
);
CREATE TABLE fed_hub_status (
  hub             TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_ok_at      INTEGER,                  -- the last push cycle that completed
  last_error      TEXT,
  offline_since   INTEGER                   -- the first network failure of the current outage
);

-- On a hub: per spoke and feed, the spoke's cursor after the last page the hub admitted. The hub returns
-- it, so a spoke restored from a backup resumes where the hub is, and a hub restored from a backup gets
-- back what it lost. Display-only beyond that: it changes no trust.
CREATE TABLE fed_submit_marks (
  instance     TEXT NOT NULL,
  type         TEXT NOT NULL,
  cursor       INTEGER NOT NULL,
  cursor_id    INTEGER,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (instance, type)
);
