-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Commands sent as radio text messages to the instance's service call (FOUND / DNF / NOTE / HELP),
-- whatever transport carried them. One row per command: who sent it, which account it resolved to,
-- how far the message is trusted (heard at an attested RF site, or a signed browser batch), and what
-- became of it. A command that arrived only over the internet waits as `pending` until the signed-in
-- player confirms it; its find is scored at the time the message was sent and the score is kept here,
-- so a later confirmation does not depend on positions that have since been pruned.
CREATE TABLE IF NOT EXISTS radio_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_call   TEXT NOT NULL,              -- sender as heard, with SSID
  account_id  TEXT,                       -- account holding the verified base call (null when unresolved)
  command     TEXT NOT NULL,              -- found | dnf | note | help | invalid
  cache_id    INTEGER,
  cache_code  TEXT,
  body        TEXT,                       -- log text after the cache code
  raw_text    TEXT NOT NULL,              -- the message text as received (duplicate detection)
  msg_no      TEXT,                       -- APRS message number, when the sender numbered it
  port        TEXT,                       -- ingest port that carried it (kiss-tnc, aprs-is, meshcom, …)
  heard_via   TEXT,
  igate_call  TEXT,
  trusted     INTEGER NOT NULL DEFAULT 0, -- 1 = heard at an attested RF site or signed by the sender's device key
  status      TEXT NOT NULL,              -- logged | pending | rejected | help | discarded | expired
  reason      TEXT,                       -- why a command was rejected
  score       TEXT,                       -- JSON find score at message time (pending finds)
  log_id      INTEGER,                    -- cache_logs.id once logged
  sent_at     INTEGER NOT NULL,           -- message timestamp
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  replied_at  INTEGER                     -- when a text reply was queued (per-destination reply limit)
);
CREATE INDEX IF NOT EXISTS idx_radio_commands_sender ON radio_commands (from_call, sent_at);
CREATE INDEX IF NOT EXISTS idx_radio_commands_account ON radio_commands (account_id, status);
