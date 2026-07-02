-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Push + email-digest delivery (ADR-4b, docs/design/11 M4). Web-push subscriptions (the enhancement) and
-- the email digest of unseen watch alerts (the MANDATORY fallback). In-app alerts already exist (W1).
CREATE TABLE IF NOT EXISTS push_subs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT,
  auth       TEXT,
  topics     TEXT,                              -- comma list: nearby | new_cache | watch
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, endpoint)
);
-- track which alerts have already gone out in a digest (so we never re-send)
ALTER TABLE watch_alerts ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
-- per-account email-digest opt-out (default on — it's the iOS/no-push fallback)
ALTER TABLE accounts ADD COLUMN notify_digest INTEGER NOT NULL DEFAULT 1;
