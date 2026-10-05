-- Moderation: what players report, what the sysop does about it, and which accounts are suspended.
-- All three stay on this instance and never federate. A removal that peers must follow travels as a signed
-- tombstone (tombstones.ts), never as one of these rows.

-- A report a player (or a signed-out visitor) files against a cache, a log, a media item, a message or a
-- profile. Only the sysop reads reports; the reported person never learns who filed one.
CREATE TABLE moderation_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind      TEXT NOT NULL,                  -- cache | log | media | message | bbs | mailbox | meshcom | profile
  target_id        TEXT NOT NULL,                  -- the row id, or the base call of a profile
  target_label     TEXT,                           -- what the target was when reported (a code, a call)
  target_account   TEXT,                           -- the account the content belongs to, when one does
  category         TEXT NOT NULL,                  -- spam | offensive | unsafe | copyright | other
  text             TEXT,                           -- the reporter's own words, length-capped
  reporter_account TEXT,                           -- NULL for a signed-out report, and after the reporter's erasure
  reporter_call    TEXT,
  status           TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  resolution       TEXT,                           -- the sysop's note on how it was settled
  resolved_by      TEXT,
  resolved_at      INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_moderation_reports_status ON moderation_reports (status, created_at);
CREATE INDEX idx_moderation_reports_target ON moderation_reports (target_kind, target_id);
CREATE INDEX idx_moderation_reports_reporter ON moderation_reports (reporter_account);

-- The audit log: one row per moderation action, kept as the instance's legitimate-interest record. The
-- person an action concerns finds the rows about their account in their data export.
CREATE TABLE moderation_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  actor_call     TEXT NOT NULL,                    -- the sysop's call, or OPERATOR for a scripted action
  action         TEXT NOT NULL,                    -- remove | restore | suspend | unsuspend | resolve | reopen
  target_kind    TEXT NOT NULL,                    -- as moderation_reports, plus account and report
  target_id      TEXT NOT NULL,
  target_label   TEXT,
  target_account TEXT,
  reason         TEXT
);
CREATE INDEX idx_moderation_log_at ON moderation_log (at);
CREATE INDEX idx_moderation_log_account ON moderation_log (target_account);

-- A suspended account: no sign-in, no write and no transmission through this instance while it holds.
-- `until` NULL holds until the sysop lifts it. The person's public content stays unless removed on its own.
CREATE TABLE account_suspensions (
  account_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  until      INTEGER,
  by_call    TEXT NOT NULL,
  at         INTEGER NOT NULL
);

-- A cache the sysop removed: archived, hidden from everyone but its owner and the sysop, and closed to the
-- owner's edits. The row stays so its finds and adoption trail keep their cache.
ALTER TABLE caches ADD COLUMN removed_at INTEGER;
ALTER TABLE caches ADD COLUMN removed_reason TEXT;
