-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0014_tombstones.sql — F4/T1.3 + ADR-5: signed tombstones for GDPR delete propagation.
--
-- A delete on one instance must remove the PII-bearing mirrored copies on peers. Anonymising a find
-- locally is not enough: the finds feed cursor is append-only by id, so an UPDATE never re-serves the
-- anonymised row — peers keep the pre-deletion copy (with the real callsign) forever. A signed,
-- PII-free tombstone actively tells peers "purge mirrored record <global-id>". Caches instead
-- propagate via archive + updated_at bump (they re-serve through the caches feed), so account-delete
-- emits find tombstones; the apply path handles any kind uniformly by global id.

-- Our own tombstones — served in our signed /federation/tombstones feed (origin = this instance).
CREATE TABLE tombstones (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic feed cursor (the uuid id is not ordered)
  id         TEXT NOT NULL UNIQUE,              -- uuid of the tombstone
  kind       TEXT NOT NULL,                     -- 'account' | 'find' | 'cache'
  target_id  TEXT NOT NULL,                     -- namespaced global id of the removed record (NEVER a callsign/PII)
  origin     TEXT NOT NULL,                     -- emitting instance
  ts         INTEGER NOT NULL,                  -- emit time (unix seconds)
  sig        TEXT                               -- reserved; the feed signs at serve time like the other feeds
);
CREATE INDEX idx_tombstones_ts ON tombstones(ts);

-- Applied peer tombstones — suppress re-mirroring, give idempotency, and bound retention.
CREATE TABLE remote_tombstones (
  target_id   TEXT PRIMARY KEY,  -- the global id a peer tombstoned (lookup on every mirror upsert)
  origin      TEXT NOT NULL,     -- the instance that emitted it
  kind        TEXT NOT NULL,
  ts          INTEGER NOT NULL,  -- emit time carried from the tombstone
  mirrored_at INTEGER NOT NULL
);

-- Per-peer cursor for the tombstones feed (parallels caches/finds/keys cursors).
ALTER TABLE fed_peers ADD COLUMN tombstones_cursor INTEGER NOT NULL DEFAULT 0;
