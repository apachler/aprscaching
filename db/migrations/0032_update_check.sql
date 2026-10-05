-- The newest published release, as the daily update check last read it from the project's releases
-- (updatecheck.ts). One row: the release tag and its page, the ETag that keeps the next request a cheap 304,
-- and when the check last got an answer. Whether an update is available is worked out on read against the
-- running version, so a restart onto the new release clears it at once.
CREATE TABLE update_check (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  tag        TEXT,
  url        TEXT,
  etag       TEXT,
  checked_at INTEGER NOT NULL
);
