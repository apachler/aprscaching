-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Account UI-preferences sync. A person's device-independent UI settings (theme, units/locale,
-- pinned workbench apps, basemap choice) follow the ACCOUNT, not the browser — so signing in on a
-- second device restores them. One small JSON blob per account (validated + size-capped server-side);
-- guests keep the same settings in localStorage only. Keyed by account_id (person), per ADR-1/ADR-2:
-- prefs belong to the person, not a bare callsign. All three runtimes. Inside the GDPR export/erase.
CREATE TABLE account_prefs (
  account_id TEXT PRIMARY KEY,
  prefs      TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0
);
