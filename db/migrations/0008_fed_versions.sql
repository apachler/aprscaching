-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Replay protection and relay isolation for federation.

-- The highest version applied per mirrored global id. A frame is applied only when its version is
-- strictly greater, so a replayed older record — or a different record at the same version — never
-- rolls a mirror back. Relay queries use it to be answered once per gid.
CREATE TABLE fed_versions (
  gid        TEXT PRIMARY KEY,
  origin     TEXT NOT NULL,
  v          INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

-- A cache's federation version is its revision, counted up on every change, so two edits within one
-- second are still two versions. (updated_at stays the page cursor; it is not bumped, because a
-- timestamp moved ahead of the clock would let a consumer's cursor skip rows written after it.)
ALTER TABLE caches ADD COLUMN fed_rev INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER caches_fed_rev AFTER UPDATE ON caches
WHEN NEW.fed_rev = OLD.fed_rev
BEGIN
  UPDATE caches SET fed_rev = OLD.fed_rev + 1 WHERE id = NEW.id;
END;

-- Relay queries belong to whoever queued them: the hash of the ticket handed back at enqueue time
-- reads the result, and `requester` keys the per-requester queue cap.
ALTER TABLE fed_relay_queue ADD COLUMN ticket_hash TEXT;
ALTER TABLE fed_relay_queue ADD COLUMN requester TEXT;
